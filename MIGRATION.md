# Song Analyzer — Migration to the Dell XPS 8930

Moving the Song Analyzer backend off the current Windows/WSL2 machine onto a
dedicated host. The Cloudflare Pages front end does not move and does not
change.

> **Related:** `chord-server/MIGRATION.md` is the existing *generic* runbook for
> getting off WSL2 onto any Linux host, and its install steps (sections 3–7)
> remain correct — this document does not duplicate them. What follows is the
> host-specific inventory, the decisions that runbook leaves open, and the
> cutover plan for this particular move.

---

## ⚠️ Scope of this inventory — read first

This inventory was produced **from the repository**, not from the live host.
The agent that wrote it runs in an ephemeral cloud container: `librosa` is not
installed, no `gunicorn`/`cloudflared` process is running, `chord-server/cache/`
does not exist, and the repo was cloned fresh.

That means everything below under "Declared" is **verified from committed
source** and is reliable. Everything under "Unverified" is a gap that must be
filled by running the listed commands **on the old host** before cutover.

Nothing here has been changed. No files on any host were modified.

---

## Phase 1 — Inventory

### 1.1 What the service is

| | |
| --- | --- |
| Component | `chord-server` — Flask app, single file |
| Source | `chord-server/app.py` (~1340 lines) |
| Served by | `gunicorn -w 4 --timeout 300 -b 127.0.0.1:5005 app:app` |
| Binds | `127.0.0.1:5005` only — **never** `0.0.0.0` |
| Port override | `PORT` env var (dev/`app.run` path only; the systemd unit hardcodes 5005) |
| Repo path on old host | **Unverified** — placeholder `/REPLACE/WITH/PATH/TO/chord-server` in the unit file |

### 1.2 Runtime and dependencies

**Declared** (`chord-server/requirements.txt`):

```
flask>=3.0
gunicorn>=22.0
yt-dlp[default]>=2024.1.1
librosa>=0.10
numpy>=1.24
scipy>=1.10
soundfile>=0.12
```

**System-level** (from `chord-server/MIGRATION.md` §3):

- `ffmpeg` — audio extraction and MP3 encode. Hard requirement.
- `ffprobe` — ships with ffmpeg; used to measure downloaded file duration.
- `python3-full`, `python3-venv` — app runs from a venv at `chord-server/venv/`.
- `nodejs` — **required**, not optional: yt-dlp needs a JS runtime to solve
  YouTube's player challenge. The code prefers Deno, accepts Node
  (`js_runtimes: {'deno': {}, 'node': {}}`).
- `cloudflared` — the tunnel.

**Unverified:** exact Python version, exact installed package versions, whether
Deno is installed alongside Node.

### 1.3 Environment variables

Names only — **no values are recorded in this document, and none were read.**

| Name | Purpose | Sensitive |
| --- | --- | --- |
| `YT_PROXY` | Residential/ISP egress proxy, scoped to the yt-dlp request only | **Yes — credentials in URL** |
| `YT_MIN_GAP` | Minimum seconds between YouTube download starts | No |
| `YT_HOURLY_CAP` | Max fresh YouTube downloads per rolling hour | No |
| `YT_SLEEP_MIN` | Jitter floor before a fetch | No |
| `YT_SLEEP_MAX` | Jitter ceiling before a fetch | No |
| `ANALYSIS_SLOTS` | Concurrent analyses across all workers (default 1) | No |
| `CACHE_MAX_SONGS` | LRU cap on cached songs (default 300) | No |
| `STREAM_DEADLINE` | Seconds before a streaming request bails out (default 100) | No |
| `PORT` | Dev-server port (default 5005) | No |

**Config file:** `/etc/chord-analyzer.env` — root-owned, **mode 600**, loaded via
`EnvironmentFile=` in the systemd unit. Must be recreated by hand on the new
host; do not copy it over a network in the clear if `YT_PROXY` is set.

### 1.4 Secrets and credential material

| Item | Location | Handling |
| --- | --- | --- |
| `cookies.txt` | `chord-server/cookies.txt` | **Live Google account credentials.** Gitignored and must stay so. Never commit, echo, or paste. Move host-to-host over SSH only. |
| `/etc/chord-analyzer.env` | `/etc/` | May contain proxy user:pass. Mode 600. |
| Cloudflare Tunnel credentials | `~/.cloudflared/<TUNNEL-ID>.json` | **This file is the tunnel's identity.** Whoever holds it can serve `api.methodictruth.com`. Treat as a secret. |

### 1.5 Data and storage

| What | Path | Notes |
| --- | --- | --- |
| Analysis cache | `chord-server/cache/` | `<video_id>.mp3` + `<video_id>.json` per song. Gitignored. |
| Cache policy | — | LRU trim to `CACHE_MAX_SONGS` (default 300), a few MB each → **~1–2 GB** |
| Pacing state | `cache/.yt-downloads.log`, `.yt-last-download`, `.yt-gate.lock`, `.yt-status.json` | Rolling-hour budget + cross-process gate. Regenerates; no need to migrate. |
| Per-video locks | `cache/<video_id>.lock` | Transient. |
| Application log | `chord-server/chord-analyzer.log` | Appended by systemd. Gitignored (`*.log`). |

> **Finding — blocks the "data on the 2TB drive" requirement.**
> `app.py:39` sets `CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')`.
> It is **hardcoded relative to the source file with no environment override**
> (verified: zero `environ` references to `CACHE_DIR`). Putting the cache on the
> 2TB drive therefore requires one of: a symlink, a bind mount, or a small patch
> to read `CACHE_DIR` from the environment. See Phase 2 §2.2.

### 1.6 Services, timers, scheduled tasks

Four units are defined in the repo. All contain `REPLACE_WITH_YOUR_USERNAME` /
`/REPLACE/WITH/PATH/TO/` placeholders — the installed copies on the old host
have been filled in and **are not in version control.**

| Unit | Role | Notes |
| --- | --- | --- |
| `chord-analyzer.service` | The Flask app under gunicorn | `Restart=on-failure`, `RestartSec=5`. Logs to a **file, not journald** — deliberate: journald's rate limiting blocks `write()` and freezes yt-dlp mid-download. Preserve this. |
| `yt-dlp-update.timer` | Daily nightly yt-dlp update | `OnCalendar=daily`, `RandomizedDelaySec=1h`, `Persistent=true`. **Not optional in practice** — YouTube breaks yt-dlp regularly. |
| `yt-dlp-update.service` | Oneshot invoked by the timer | Runs as root, drops to the app user via `runuser` for the pip install, then `systemctl restart chord-analyzer`. |
| `bgutil-pot.service` | PO-token provider for yt-dlp | Node app at `~/bgutil-ytdlp-pot-provider/server`, listens on `127.0.0.1:4416`. **Not in this repo** — separate clone + build. |
| `cloudflared` | The tunnel | Installed via `cloudflared service install`. |

**Windows-side scheduled task (old host only):** a Task Scheduler entry running
`wsl.exe -d <Distro> --exec /bin/true` at startup, because WSL2 does not
auto-start on Windows boot. Plus `powercfg` sleep timeouts disabled. Both become
**unnecessary** if the new host runs Linux natively — this is a large part of
the reason for the move.

**Unverified:** whether `bgutil-pot` is actually enabled and running today, and
whether any `crontab` entries exist outside systemd.

### 1.7 How it reaches the internet

```
Browser
  │  https://methodictruth.com  ──────────►  Cloudflare Pages  (static site — does NOT move)
  │
  └─ fetch() ─► https://api.methodictruth.com
                        │
                Cloudflare edge
                        │  (tunnel — outbound only, no inbound ports)
                        ▼
                  cloudflared  ──►  127.0.0.1:5005  ──►  gunicorn ──► app.py
```

- **No port forwarding. No inbound firewall holes. No public IP exposed.**
  `cloudflared` dials *out* to Cloudflare; gunicorn listens on loopback only.
- **The tunnel is portable and is the whole reason cutover is cheap.** It is
  identified by its credentials file, not by an IP. Install `cloudflared` with
  the same credentials on the new box and the hostname follows — **no DNS
  change, no cert work, no front-end change.**
- Ingress rule (`~/.cloudflared/config.yml`):
  ```yaml
  ingress:
    - hostname: api.methodictruth.com
      service: http://127.0.0.1:5005
    - service: http_status:404
  ```
- **CORS:** `app.py` sets `Access-Control-Allow-Origin: *` on responses.

### 1.8 Front-end coupling — what does *not* move

| | |
| --- | --- |
| `song-analyzer.html:593` | `const API_URL = 'https://api.methodictruth.com'` — the single point of coupling |
| `song-analyzer.html:55` | `<link rel="preconnect" href="https://api.methodictruth.com">` |
| Endpoints consumed | `POST /` (analyze, NDJSON stream), `POST /upload`, `GET /library`, `GET /result/<id>`, `GET /audio/<id>`, `GET /health` |

Because the hostname is unchanged, **zero front-end edits are required.**

**Legacy, not in the serving path** — worth confirming before they confuse
someone later: `worker/song-analyzer-worker.js`, `functions/analyze.js`,
`api/analyze.js` are earlier serverless/mock attempts superseded by the Flask
backend. Note that `functions/` *is* auto-deployed by Cloudflare Pages, so
`functions/analyze.js` is live at `/analyze` even though nothing calls it.

### 1.9 Would anything benefit from the RTX 2060?

**The pipeline as it stands: no.** Every heavy step is CPU-bound NumPy/SciPy
inside librosa — `librosa.load`, `onset_strength`, `beat_track`,
`chroma_cqt`, `feature.rms`, `spectral_centroid`. None of it touches CUDA, and
none of it would without a rewrite. ffmpeg's NVENC is video encoding and is
irrelevant to audio extraction. **A lift-and-shift gains nothing from the GPU.**

The i7-9700K will still help: analysis is a 15–25 s CPU burst, currently
serialized by `ANALYSIS_SLOTS=1`. Eight cores make raising that genuinely
useful (see Phase 2 §2.4).

**Where the GPU would earn its keep** — all of these are upgrades, not
migration work, and should be decided separately:

| Upgrade | Benefit | VRAM on a 6 GB 2060 |
| --- | --- | --- |
| **Demucs stem separation** before chroma | Biggest accuracy win available. Isolating the harmonic stem from drums/vocals is exactly what fixes template matching on dense mixes. | `htdemucs` fits comfortably; use `--segment` if tight |
| **Neural chord recognition** (madmom CNN, BTC) | The code's own comment already flags this: *"richer/ambiguous qualities need a sequence model (HMM/Viterbi or madmom), noted as a future upgrade."* Would unlock sus/dim/aug, which are currently deliberately disabled. | Small |
| Whisper transcription (lyrics) | New feature, not an improvement to an existing one | `small`/`medium` fit |
| GPU CQT (nnAudio/torchaudio) | Modest speedup, meaningful rewrite | Small |

**Recommendation: migrate first, unchanged. Treat GPU work as a follow-up
project** once the new host is stable — otherwise a migration failure and a
model failure become indistinguishable.

### 1.10 Gaps — run these **on the old host** to complete the inventory

```bash
# Where things actually live, and what the real unit files say
systemctl cat chord-analyzer cloudflared bgutil-pot yt-dlp-update.timer 2>/dev/null
systemctl is-enabled chord-analyzer cloudflared bgutil-pot yt-dlp-update.timer
systemctl list-timers --all | grep -i yt-dlp

# Versions actually installed
python3 --version; ffmpeg -version | head -1; node --version; deno --version 2>/dev/null
~/path/to/chord-server/venv/bin/pip freeze          # exact pinned set → save this
cloudflared --version

# Config presence WITHOUT printing secrets (names/sizes only)
sudo test -f /etc/chord-analyzer.env && sudo stat -c '%n %a %U' /etc/chord-analyzer.env
sudo grep -oE '^[A-Z_]+' /etc/chord-analyzer.env      # NAMES ONLY — never cat this file
ls -l ~/path/to/chord-server/cookies.txt 2>/dev/null
ls -l ~/.cloudflared/                                  # note the <TUNNEL-ID>.json filename

# Data volume to move
du -sh ~/path/to/chord-server/cache/
ls ~/path/to/chord-server/cache/*.mp3 2>/dev/null | wc -l

# Anything outside systemd
crontab -l 2>/dev/null; sudo crontab -l 2>/dev/null

# Health snapshot to compare against after cutover — SAVE THIS OUTPUT
curl -s https://api.methodictruth.com/health
```

On the **Windows** side of the old host:

```powershell
wsl -l -v
Get-ScheduledTask | Where-Object {$_.TaskName -like "*wsl*" -or $_.TaskName -like "*chord*"}
powercfg /query SCHEME_CURRENT SUB_SLEEP
```

### 1.11 Migration checklist

**Must move**

- [ ] Repo clone (or fresh `git clone` — preferred, it's public)
- [ ] Python venv — **rebuild, don't copy**; keep old `pip freeze` as the fallback pin
- [ ] `/etc/chord-analyzer.env` — recreate by hand (contains `YT_PROXY` if set)
- [ ] `cookies.txt` — **secret**, SSH/`scp` only, never commit
- [ ] `~/.cloudflared/<TUNNEL-ID>.json` + `config.yml` — **secret**, this is the tunnel identity
- [ ] `chord-server/cache/` — optional but preserves the public library
- [ ] All four systemd units, with placeholders filled in
- [ ] `bgutil-ytdlp-pot-provider` clone + `npm build` (separate repo) — **if in use**

**Must install**

- [ ] ffmpeg (+ffprobe), python3-venv, git, nodejs (and Deno, preferred by yt-dlp), cloudflared

**Must NOT move / must not exist on the new host**

- [ ] WSL2 auto-start Task Scheduler entry — obsolete if running Linux natively
- [ ] `powercfg` sleep workarounds — ditto
- [ ] Nothing bound to `0.0.0.0`; no inbound port opened; **port 5005 stays on loopback**

**Must not run in two places at once**

- [ ] `cloudflared` — two connectors on one hostname split traffic and make
      failures look intermittent. Stop the old one as the new one starts.

---

## Phase 2 — Plan

### 2.1 How to run it on the XPS 8930

The existing runbook already states the conclusion — *"it should run Linux
natively… the point of this migration is partly to leave WSL2's quirks behind,
so don't reintroduce them."* The inventory supports that: three of the
operational hazards on the current host (WSL2 not auto-starting, Windows sleep
being indistinguishable from powered-off, `/etc/wsl.conf` needing
`systemd=true`) are **WSL2 artifacts that simply cease to exist on bare metal.**

| Option | Verdict | Trade-off |
| --- | --- | --- |
| **A. Wipe Windows → Ubuntu 24.04 LTS native** | **Recommended** | Everything in `chord-server/MIGRATION.md` applies unchanged. Real systemd, real boot behaviour, cleanest CUDA path for the Demucs upgrade later. **Cost: you lose Windows on that box.** |
| B. Keep Windows + WSL2 | Not recommended | Re-imports the exact failure modes being migrated away from. You'd be moving the problem to newer hardware. |
| C. Keep Windows + Docker Desktop | Workable fallback | Containerised, reproducible. But Docker Desktop wants a logged-in user session unless carefully configured for headless start, which is a new version of the same "does it survive a reboot" problem. GPU passthrough works but adds a layer. |
| D. Native Windows + NSSM services | Not recommended | All four systemd units need rewriting; the deliberate log-to-file behaviour and the `runuser` pattern have no clean equivalent. Most work, least benefit. |
| E. Proxmox/hypervisor + Linux VM | Good if you want the box to do more | Adds a virtualisation layer to learn. GPU passthrough is fiddly. Sensible only if you plan other VMs. |

**Recommendation: A**, unless you need Windows on that machine — which is the
first question in §2.6, because it changes this answer.

### 2.2 Storage layout

| Drive | Holds | Why |
| --- | --- | --- |
| **512 GB NVMe** | OS, `~/methodictruth` repo, `venv`, logs | Small, benefits from fast random IO |
| **2 TB HDD** | `chord-server/cache/` — MP3s + result JSON | Bulk, sequential, grows without bound if `CACHE_MAX_SONGS` is raised |

Because `CACHE_DIR` is hardcoded (§1.5), pick one:

1. **Symlink — zero code change, recommended for cutover**
   ```bash
   sudo mkdir -p /mnt/data/chord-cache && sudo chown $USER:$USER /mnt/data/chord-cache
   ln -s /mnt/data/chord-cache ~/methodictruth/chord-server/cache
   ```
2. **Bind mount** — same effect, survives someone deleting the symlink; needs an
   `/etc/fstab` entry.
3. **Patch `app.py`** to honour a `CACHE_DIR` env var — cleanest long-term, and
   a genuinely small change. Worth doing *after* cutover, not during.

Mount the HDD by **UUID** in `/etc/fstab`, not `/dev/sdX` — device order is not
stable across reboots, and a cache dir that silently vanishes on boot is a
miserable fault to diagnose. With the HDD holding the cache, raising
`CACHE_MAX_SONGS` well past 300 becomes cheap.

### 2.3 Cutover — parallel bring-up, then flip the tunnel

The tunnel makes this genuinely low-risk: the old host keeps serving until the
moment `cloudflared` moves, and moving it back is the entire rollback.

**Stage 1 — build the new host (old host untouched, still serving)**
1. Install Ubuntu 24.04 LTS; mount the 2 TB by UUID; create the cache symlink.
2. `apt install ffmpeg python3-full python3-venv git nodejs` (+ Deno).
3. Clone the repo, create the venv, `pip install -r requirements.txt`.
4. Recreate `/etc/chord-analyzer.env` by hand, `chmod 600`.
5. Copy `cookies.txt` over SSH if in use.
6. Install the four systemd units with placeholders filled in; enable
   `chord-analyzer` and `yt-dlp-update.timer`. **Do not install cloudflared yet.**

**Stage 2 — test the new host in isolation (still not serving traffic)**
```bash
curl -s localhost:5005/health          # expect ok:true
```
Then, bypassing the tunnel entirely, from another machine on the LAN:
```bash
ssh -L 5005:127.0.0.1:5005 user@new-host    # tunnel it to yourself, don't open a port
```
- Upload a local audio file → exercises the whole analysis path with **no
  YouTube involvement**. If this works, the box is healthy.
- Analyze a YouTube link → exercises IP reputation and yt-dlp.
- Confirm deep analysis (structure blocks, energy curve, key confidence)
  appears — proves you're on current code, not a stale checkout.

**Stage 3 — carry the library over** (optional, do it last so it's fresh)
```bash
rsync -avz old-host:~/path/to/chord-server/cache/ /mnt/data/chord-cache/
```

**Stage 4 — the flip** (the only step with downtime; seconds)
1. Copy `~/.cloudflared/` (credentials JSON + `config.yml`) to the new host.
2. On the **old** host: `sudo systemctl stop cloudflared`
3. On the **new** host: `sudo cloudflared service install && sudo systemctl enable --now cloudflared`
4. Verify through the real public path:
   ```bash
   curl -s https://api.methodictruth.com/health
   curl -s https://api.methodictruth.com/library | head -c 300
   ```
5. Load `song-analyzer.html` in a browser and run one upload + one YouTube analyze.

**Stage 5 — rollback (keep available for days, not hours)**
Nothing about DNS, certificates, or the front end changed, so rollback is:
stop `cloudflared` on the new host, start it on the old one. **Leave the old
WSL2 install completely intact** until you've run the new host through a few
real days, including at least one reboot and one `yt-dlp-update.timer` firing.

### 2.4 Surviving reboots, health, logging

**Auto-start** — on native Linux this is just systemd, with none of the
Windows-side scaffolding:
```bash
sudo systemctl enable chord-analyzer cloudflared yt-dlp-update.timer
# and bgutil-pot if in use
systemctl is-enabled chord-analyzer cloudflared yt-dlp-update.timer   # all → enabled
```
**Then actually reboot and re-check `/health` before you trust it.** "Enabled"
is a claim; a reboot is the test.

**Keep the log-to-file behaviour.** The `StandardOutput=append:` lines are not
stylistic — the unit file explains that journald's rate limiting makes
`write()` block once the pipe fills, freezing yt-dlp mid-download until
gunicorn's timeout kills it. Add `logrotate` for `chord-analyzer.log`, since
nothing currently truncates it.

**Health checks.** `/health` already reports `ok`, cached song count, a
`youtube` status word (`ok`/`degraded`/`failing`/`unknown`), `yt_proxy_configured`
and `cookies_present` as booleans, the yt-dlp version, and both halves of the
PO-token path. A cron entry hitting it every few minutes and shouting on
`ok != true` is enough monitoring for this.

**Tuning for 8 cores.** `ANALYSIS_SLOTS` defaults to 1 because the old box
thrashed. On an i7-9700K, 2–3 is reasonable — raise it *after* cutover, one
step at a time, watching analysis wall-time. Leave gunicorn at `-w 4`.

### 2.5 Risks

| Risk | Mitigation |
| --- | --- |
| Two `cloudflared` connectors serving one hostname | Stop old before starting new. Symptom: intermittent, undiagnosable failures. |
| Cache symlink missing after reboot → cache silently rebuilds from empty | Mount by UUID in `/etc/fstab`; verify after the test reboot. |
| Rebuilt venv pulls a newer, broken library | Keep the old host's `pip freeze` as a pin to fall back to. |
| `cookies.txt` leaked in transit or committed | `scp` only; it stays gitignored; never `cat` it. |
| YouTube path breaks but uploads work | Expected and survivable — `/health` distinguishes them. Residential IP is retained by staying on a home connection. |
| New host's residential IP is the same connection | No change in IP reputation — this is why the home-server option is favoured. |

### 2.6 Open questions — I need these answered before executing

1. **Must Windows stay on the XPS 8930?** This decides option A vs C and
   changes most of Phase 2. You said "fresh Windows install", which may mean
   you intend to keep it — or just that it arrived that way.
2. **Is `bgutil-pot.service` actually in use today?** It's defined in the repo
   but its provider lives in a separate clone. `curl -s localhost:4416/ping` on
   the old host settles it. The current `/health` output will also say.
3. **Is `YT_PROXY` set today?** If the old host is on your home connection it
   should be empty — confirm, because it changes what has to be recreated.
   (`/health` reports `yt_proxy_configured` as a boolean.)
4. **Carry the cache over?** ~1–2 GB. Keeps the public library populated on day
   one; skipping it just means an empty library that refills.
5. **Lift-and-shift only, or do you want the GPU work scoped too?** My strong
   recommendation is migrate unchanged first — but if Demucs/neural chords are
   the actual reason for the new box, that changes the target state.
6. **Is the old host's repo path and Linux username known?** The unit files in
   git are placeholders; I need the real values (or you fill them in locally).

---

*Written during Phase 1–2. Nothing has been executed. No host was modified.*
