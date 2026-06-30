# Song Analyzer — Local Chord-Detection Backend

A self-hosted Flask service that replaces the mock data in
`worker/song-analyzer-worker.js` with real audio analysis: downloads a
YouTube video's audio with `yt-dlp`, then uses `librosa` to detect tempo
(BPM), key, and a chord progression with timestamps.

Designed to run on a machine you control (e.g. the N100 box) and be exposed
through a Cloudflare Tunnel, since it needs `ffmpeg` and real CPU time per
request — not something a Cloudflare Worker can do.

## 1. Install on the device

```bash
sudo apt install -y ffmpeg python3-full
cd chord-server
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 2. Run it

For quick local debugging:

```bash
source venv/bin/activate
python app.py
# listens on http://127.0.0.1:5005
```

For anything resembling production, run it under gunicorn instead — the
Flask dev server handles one request at a time, which falls over the moment
two people use the tool at once:

```bash
source venv/bin/activate
gunicorn -w 4 --timeout 300 -b 127.0.0.1:5005 app:app
```

`-w 4` runs 4 worker processes so requests for different songs are handled
in parallel (bounded by CPU core count). `--timeout 300` keeps gunicorn from
killing a worker mid-analysis — its default 30s timeout is far shorter than a
download + analysis can take, and the generous 300s ceiling leaves headroom
for an occasional slow YouTube download instead of failing it outright (a
healthy run is ~15-25s; see the timing logs). `chord-analyzer.service`
(step 3) already runs it this way.

Test it:

```bash
curl -X POST http://127.0.0.1:5005 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

A 3-4 minute song takes roughly 10-30 seconds to analyze (download + librosa),
not 1-2 minutes — that loading copy in the frontend was a conservative
estimate from the original mock-data version.

## In-page playback (why there's no YouTube embed)

The frontend used to embed the YouTube player for play-along. YouTube now
throws "Sign in to confirm you're not a bot" at *embedded* players based on
the viewer's own IP/cookies — nothing the server can fix, and it made the
feature unreliable for real visitors. So instead, this backend serves the
audio it already downloaded: the analyzed track is saved as
`cache/<video_id>.mp3` and exposed at `GET /audio/<video_id>` (with HTTP
range support so the `<audio>` element can seek). The page plays that MP3
directly — no YouTube player, no bot-check, no ads. The `/audio` id is
charset-validated so it can't escape the cache directory.

This means MP3 playback is also a CORS resource: `app.py` sends
`Access-Control-Allow-Origin: *`, and the frontend's `<audio>` element uses
`crossorigin="anonymous"` so the in-page spectrum visualizer (Web Audio) can
read its samples.

## Caching and concurrent requests

Every analysis result is written to `cache/<video_id>.json` and the playable
audio to `cache/<video_id>.mp3`; neither expires — a given video's chords,
key, and BPM don't change, so a repeat request for the same song is served
straight from disk instead of re-downloading and re-analyzing it. The `.mp3`
files are a few MB each and accumulate over time; delete files from `cache/`
(or the whole directory) to reclaim space or force a re-analysis.

If two requests for the *same* video arrive while neither is cached yet, the
second one doesn't kick off a duplicate download/analysis — it waits on a
per-video file lock (`cache/<video_id>.lock`) and then reads the result the
first request just wrote. This works across gunicorn's separate worker
processes, not just within one process. Requests for *different* videos
never block each other.

## 3. Run it as a service (so it survives reboots)

Edit `chord-analyzer.service`, replacing `/REPLACE/WITH/PATH/TO/chord-server`
and `REPLACE_WITH_YOUR_USERNAME` with the actual path and your username,
then:

```bash
sudo cp chord-analyzer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chord-analyzer
sudo systemctl status chord-analyzer
journalctl -u chord-analyzer -f   # tail logs
```

## 4. Expose it with a Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create song-analyzer
cloudflared tunnel route dns song-analyzer api.methodictruth.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID FROM THE CREATE STEP>
credentials-file: /home/<you>/.cloudflared/<TUNNEL_ID>.json

ingress:
  - hostname: api.methodictruth.com
    service: http://localhost:5005
  - service: http_status:404
```

Then run it as a service too:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

## 5. Point the frontend at it

In `song-analyzer.html`, change:

```javascript
const API_URL = 'https://song-analyzer-api.sergmacedo1.workers.dev';
```

to:

```javascript
const API_URL = 'https://api.methodictruth.com';
```

That's the only frontend change needed — the response shape this service
returns already matches what `song-analyzer.html` expects.

## "Sign in to confirm you're not a bot"

YouTube sometimes blocks `yt-dlp` downloads from this server with:

```
ERROR: [youtube] <id>: Sign in to confirm you're not a bot.
```

This is YouTube rate-limiting/flagging the server's IP, not a bug in this
codebase — it happens to `yt-dlp` users generally, more often on
cloud/datacenter IPs but can hit residential ones too. The fix is to give
`yt-dlp` cookies from a real logged-in browser session so requests look
like they're coming from an authenticated browser, not a script.

1. Log into youtube.com in a normal browser, on the same network the
   server uses (or any browser, then transfer the file).
2. Export cookies in Netscape format — easiest via a browser extension
   such as "Get cookies.txt LOCALLY" (Chrome/Firefox), exporting for the
   `youtube.com` domain.
3. Save the exported file as `chord-server/cookies.txt` (already
   gitignored — **never commit this file**, it contains live session
   auth and would let someone hijack the YouTube account it came from).
4. No code or service restart needed — `app.py` checks for
   `cookies.txt` on every request and uses it automatically if present.

Cookies expire/rotate periodically (weeks to months depending on the
account), so if the bot-check error comes back after a while, just
re-export and overwrite `cookies.txt`.

## "Requested format is not available"

YouTube also runs a separate signature/n-parameter JS challenge on its
player JS, unrelated to the bot-check above. When `yt-dlp` can't solve it,
every format except storyboard images (`mhtml`) gets filtered out, which
surfaces here as "Requested format is not available."

Solving it requires:

1. **A recent `yt-dlp` build.** Fixes for YouTube's evolving challenges
   often land in nightly builds well before a tagged stable release, so a
   plain `pip install -U yt-dlp` can report "already satisfied" while the
   fix you need still isn't out. Use `pip install -U --pre "yt-dlp[default]"`
   instead — the `[default]` extras pull in `yt-dlp-ejs`, the package that
   actually does the challenge-solving. See `yt-dlp-update.service`/
   `.timer` below to keep this current automatically.
2. **A JS runtime.** `yt-dlp-ejs` needs Node.js (v22+), Deno, or QuickJS
   installed to execute the challenge-solving script. This repo's `app.py`
   sets `'js_runtimes': ['node']` directly in `ydl_opts`, so install Node
   (`sudo apt install nodejs`) and that's it — no extra config file needed.
   (`--js-runtimes` / `~/.config/yt-dlp/config` only apply to the `yt-dlp`
   CLI tool's own argument parser; they're silently ignored when using
   `yt_dlp.YoutubeDL(...)` as a library, which is what `app.py` does.)

## Keeping yt-dlp current automatically

YouTube's anti-bot/anti-scraping layers change often enough that pinning a
version and forgetting about it isn't viable. `yt-dlp-update.service` +
`yt-dlp-update.timer` run `pip install -U --pre "yt-dlp[default]"` daily and
restart `chord-analyzer` afterward, so fixes land within a day without
manual intervention:

```bash
cd chord-server
sed -i "s|REPLACE_WITH_YOUR_USERNAME|$(whoami)|g; s|/REPLACE/WITH/PATH/TO/chord-server|$(pwd)|g" yt-dlp-update.service
sudo cp yt-dlp-update.service yt-dlp-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yt-dlp-update.timer
systemctl list-timers yt-dlp-update.timer   # confirm it's scheduled
```

## Boot resilience (WSL2 + Windows host)

If this runs inside WSL2 on a Windows machine (as opposed to bare-metal
Linux), `systemctl enable` on `chord-analyzer` and `cloudflared` alone is
**not** enough to survive a reboot — there are two Windows-side gaps to
close too.

**1. WSL2 doesn't auto-start when Windows boots.** The WSL2 VM only starts
when something explicitly launches it (opening a terminal, an app
connecting to it, etc.), so even with both services `enabled` inside the
distro, a cold Windows boot with nobody opening a WSL session leaves
everything off. Fix it with a Windows Task Scheduler entry:

- Get your distro's exact name first (PowerShell): `wsl -l -v`
- Task Scheduler → **Create Task...** (not "Create Basic Task" — the
  wizard hides the checkboxes below)
- General tab: check **Run whether user is logged on or not** and
  **Run with highest privileges**
- Triggers tab: New trigger, **At startup**
- Actions tab: New action, Program/script `wsl.exe`, arguments
  `-d <DistroName> --exec /bin/true` (e.g. `-d Ubuntu --exec /bin/true`)
- Conditions tab: uncheck "Start the task only if the computer is on AC
  power" if checked

**2. Windows sleep looks identical to powered-off from the outside.**
Closing an RDP session (without logging off) removes the "active session"
signal that blocks the idle timer, so the machine sleeps per its power
plan — no ping, no RDP, no SSH, indistinguishable from off until someone
physically wakes it. Disable sleep/monitor timeout while on AC power
(PowerShell, as Administrator):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
```

**3. Confirm both services are actually enabled** (inside WSL):

```bash
systemctl is-enabled chord-analyzer
systemctl is-enabled cloudflared
```

Both should print `enabled`. Also confirm `systemd=true` is set under
`[boot]` in `/etc/wsl.conf` — without it, `systemctl` doesn't work in WSL2
at all.

**4. Don't forget gunicorn has to actually be installed in the venv**
before flipping `ExecStart` over to it. If `chord-analyzer` fails to start
with `status=203/EXEC` in `systemctl status`, that means systemd couldn't
execute the binary at all (not a Python runtime error) — almost always
because `gunicorn` was never installed:

```bash
cd /path/to/chord-server
source venv/bin/activate
pip install -r requirements.txt   # or: pip install "gunicorn>=22.0"
which gunicorn                    # should print a path inside venv/bin/
deactivate
sudo systemctl daemon-reload && sudo systemctl restart chord-analyzer
```

**5. Without `User=`/`Group=`/`Environment=HOME=...`, systemd runs the
service as root**, not the user who set it up. That silently breaks
anything keyed to `$HOME` — `cache/` ends up owned by root (later requests
from the real user get `PermissionError`), and any user-level config gets
read from `/root` instead of the real home directory. If `chord-analyzer`
was ever started before these lines were added to the unit file, fix
ownership after adding them:

```bash
sudo chown -R $(whoami):$(whoami) cache
```

## "Analysis failed" / "Load failed" only under systemd (never from the CLI)

The most baffling failure mode this service can hit: every manual test
works — `yt-dlp` from the CLI, `python app.py`, even `gunicorn` run by hand
all download and analyze in seconds — but requests through the **installed
systemd service** stall for exactly ~120 seconds and then die, surfacing in
the browser as "Failed to fetch" / "Load failed". The stack trace shows the
worker blocked deep in an SSL read (during the download) or in
`subprocess.communicate` (during ffmpeg), killed by gunicorn's `--timeout`.

The cause is **not** YouTube, the network, or the app code. It's the
**journald pipe**. Under systemd, a service's stdout/stderr is a pipe to
journald, which rate-limits log volume. `yt-dlp` and its `ffmpeg`/`node`
subprocesses emit a firehose of progress/diagnostic output to stderr; once
that fills the pipe faster than journald drains it, the next `write()`
**blocks**, which freezes the worker mid-download. Run the identical code
with stdout pointed at a regular file (`python app.py >log 2>&1`, or
`gunicorn ... >log 2>&1`) and it never blocks — a regular file's `write()`
always returns immediately. That's the entire difference between the tests
that pass and the service that hangs.

Two-part fix, both already in this repo:

1. `app.py` sets `'noprogress': True` in `ydl_opts` so `yt-dlp` stops
   streaming the download progress bar (`quiet: True` alone does **not**
   silence it — progress goes to stderr independently).
2. `chord-analyzer.service` sets `StandardOutput=append:` and
   `StandardError=append:` to a log file instead of journald, so nothing
   the worker (or any subprocess it spawns) writes can ever block on a full
   pipe. View the logs with `tail -f chord-server/chord-analyzer.log`
   instead of `journalctl -u chord-analyzer` (journald still carries
   systemd-level start/stop/crash lines, just not the app's own output).

If you ever see this symptom come back, confirm the `StandardOutput`/
`StandardError` lines are still present in the **installed** unit
(`/etc/systemd/system/chord-analyzer.service`), not just the repo copy.

## Live progress (streaming response)

`POST /` streams **newline-delimited JSON** rather than returning a single
blob. The work runs in a worker thread that pushes events through a queue;
the request relays them as they happen:

```
{"stage": "download", "pct": 42}
{"stage": "convert"}
{"stage": "load"}
{"stage": "analyze"}
{"stage": "done", "success": true, "title": ..., "bpm": ..., "chords": [...]}
```

The `download` percentage is real (from `yt-dlp`'s progress hook). The final
`done` line always carries the complete result, so a client or proxy that
buffers the stream still gets a correct answer — the frontend reads it with
`fetch` + a stream reader and falls back to a plain read otherwise. Cache
hits emit a single `done` line instantly.

## Accuracy notes

Chord detection is **beat-synchronous** template matching: `librosa` tracks
the beat, the chroma is aggregated over half-bars (so a chord lands on the
musical grid instead of an arbitrary 2-second window), and a mode filter
removes flicker. Each segment is matched against **major and minor** triad
templates, then a 7th is added only when the flat-7th degree actually carries
energy comparable to the chord tones (giving dominant-7 / minor-7).

That triad-only core is deliberate. Earlier versions also tried sus2/sus4,
diminished, and major-7 templates — but each of those sits a single semitone
from a major or minor triad, so on real chroma (energy smeared across every
pitch class by harmonics, bass, and vocals) the matcher flips onto them on
noise, littering the chart with phantom chords. Restricting to the two
unambiguous triads plus an energy-grounded flat-7th yields charts that track
the actual progression. It won't catch sus/9th/11th or slash chords; reliable
detection of those needs a sequence model (HMM/Viterbi) or `madmom`'s ML chord
recognition — the documented upgrade path.

Playback audio is loudness-normalized to EBU R128 (`-16 LUFS`) during the
MP3 extraction, so songs play back at a consistent volume.

## Cost

Runs entirely on hardware you already own. No per-request cost, no API
keys required — `yt-dlp` and `librosa` do everything locally.
