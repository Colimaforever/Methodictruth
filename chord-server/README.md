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
gunicorn -w 4 --timeout 120 -b 127.0.0.1:5005 app:app
```

`-w 4` runs 4 worker processes so requests for different songs are handled
in parallel (bounded by CPU core count). `--timeout 120` keeps gunicorn from
killing a worker mid-analysis — its default 30s timeout is shorter than a
single chord analysis can take. `chord-analyzer.service` (step 3) already
runs it this way.

Test it:

```bash
curl -X POST http://127.0.0.1:5005 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

A 3-4 minute song takes roughly 10-30 seconds to analyze (download + librosa),
not 1-2 minutes — that loading copy in the frontend was a conservative
estimate from the original mock-data version.

## Caching and concurrent requests

Every analysis result is written to `cache/<video_id>.json` and never
expires — a given video's chords, key, and BPM don't change, so a repeat
request for the same song is served straight from disk instead of
re-downloading and re-analyzing it. Delete a file from `cache/` (or the
whole directory) to force a re-analysis.

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

## Accuracy notes

Chord detection here is template matching (12 major + 12 minor triads
compared against 2-second chroma windows) — it won't catch 7ths, 9ths, sus,
or slash chords, and it'll have rough edges on songs with heavy
distortion/vocals-only sections. Good enough to validate the feature; a
later upgrade path is `madmom`'s ML-based chord recognition if the
template-matching accuracy isn't good enough in practice.

## Cost

Runs entirely on hardware you already own. No per-request cost, no API
keys required — `yt-dlp` and `librosa` do everything locally.
