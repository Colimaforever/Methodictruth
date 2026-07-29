# Moving the backend off WSL2

The analyzer currently runs on a Windows PC under WSL2. That works, but the
tool is only up when that machine is, and WSL2 adds its own failure modes
(see "Boot resilience" in the README). This is the runbook for moving it to a
proper always-on Linux host — **either a home server or a cloud VM.** The
steps are identical from section 3 onward; only the trade-offs differ.

The migration itself is genuinely easy, because **the Cloudflare Tunnel is
portable**: the tunnel is an outbound connection identified by a credentials
file, not by an IP. Install `cloudflared` on the new host with the same
credentials and `api.methodictruth.com` follows you. No DNS changes, no
frontend changes, no certificate work.

**But read section 2 first.** There is one real trade-off, and it's the whole
reason this document is longer than "apt install and go".

---

## 1. Pick the host

**If you have a home server, that is probably the right answer** — not a
budget compromise. Section 2 explains why in detail, but the short version is
that a residential IP is a genuine technical asset for this workload, and a
cloud VM doesn't have one. A home server is free, already paid for, and
strictly better at the hardest part of this job.

| Option | Cost | Notes |
| --- | --- | --- |
| **Home server** | $0 | **Recommended.** Residential IP = the YouTube path just works. Needs native Linux (or Docker), not WSL2. Uptime is your power + internet. |
| Hetzner CX22 | ~$4/mo | Best cloud value: 2 vCPU / 4 GB / 40 GB NVMe, Ashburn US-East. Datacenter IP — read section 2. |
| Oracle Cloud Always Free | $0 | 4 ARM cores / 24 GB, genuinely free. Signup is finicky, capacity comes and goes. Still a datacenter IP. |
| DigitalOcean / AWS / GCP | varies | If you have credits, use them. Same steps, any Ubuntu 22.04+ host. |

Sizing either way: analysis is a CPU burst of ~15–25 s per song, serialized by
`ANALYSIS_SLOTS` (default 1). 2 cores / 4 GB is comfortable — almost any home
server clears this easily. Disk is dominated by the MP3 cache:
`CACHE_MAX_SONGS` (default 300) at a few MB each is ~1–2 GB.

The one thing to check on a home server: it should run **Linux natively** (a
normal distro, a NAS that supports Docker, a Proxmox VM). The point of this
migration is partly to leave WSL2's quirks behind, so don't reintroduce them.

---

## 2. The trade-off that decides home vs cloud: IP reputation

YouTube weighs **the reputation of the requesting IP** heavily. A residential
address — your home connection, which is what the WSL2 box has today and what
a home server would also have — sails through. A datacenter address, which is
every cloud VM, is treated as presumptively automated and gets
`Sign in to confirm you're not a bot` and HTTP 429s far more often.

This is the crux: **moving to a home server keeps that advantage for free.
Moving to the cloud gives it up, and buying it back costs money.** If the
YouTube path matters to you, the home server wins on the merits.

If you do go to the cloud, be aware of what does and doesn't help:

- **PO tokens are no longer sufficient.** The `bgutil-ytdlp-pot-provider`
  plugin was the standard answer to bot checks; as of recent updates,
  supplying a PO token no longer bypasses the check in the majority of cases.
  Don't build the plan around it.
- **Cookies help, but carry a risk.** `cookies.txt` from a signed-in session
  makes requests look authentic. However, using a personal account's cookies
  from a datacenter IP is a good way to get *that account* flagged. If you do
  this, use a throwaway Google account, never your main one.
- **A residential/ISP proxy is the actual fix.** Route only the YouTube hop
  through an IP that belongs to a consumer ISP, and the reputation problem
  goes away. This is what the code now supports directly.

### What "robust" looks like on a cloud VM

**On a home server, skip this entirely — leave `YT_PROXY` unset.** You already
have the residential IP this section exists to rent.

On a datacenter host, set `YT_PROXY` to a **residential or ISP (static
residential)** endpoint.
Datacenter proxies are pointless here — they are exactly what's already being
blocked. Rough market shape: residential bandwidth runs a few dollars per GB,
and ISP/static-residential is often sold per-IP per-month. Audio-only
downloads are ~3–5 MB each, so **1 GB is roughly 200–300 songs** — for a
personal-scale tool the cost is small. Providers commonly used with yt-dlp
include Webshare, IPRoyal, Oxylabs, and Bright Data; any of them work as long
as you buy *residential/ISP*, not datacenter.

Crucially, `YT_PROXY` is scoped to the yt-dlp request only. Uploads, analysis,
audio serving, and the library never touch it, so a proxy outage or an expired
proxy plan degrades one feature instead of taking the service down.

### If you'd rather not pay for a proxy

The service is fully useful without one, because the YouTube path is no longer
the only door:

- **File upload is unaffected** — it never contacts YouTube, has no rate
  limits, and after the recent work the error messages actively steer people
  to it when YouTube blocks a fetch.
- **The library cache** means every already-analyzed song replays instantly
  at zero YouTube cost.
- The built-in pacing (`YT_MIN_GAP`, `YT_HOURLY_CAP`) already spaces requests
  to avoid tripping bot detection through sheer burstiness.

A reasonable path: migrate first, run without a proxy, and watch
`/health` + the logs. Add a proxy only if YouTube failures actually annoy you.

---

## 3. Provision and install

Identical on a home server and a cloud VM. On Ubuntu 22.04/24.04 (or any
Debian-family distro), as a normal user with sudo:

```bash
# System dependencies. ffmpeg does the audio extraction; nodejs is required
# for yt-dlp to solve YouTube's player JS challenge.
sudo apt update
sudo apt install -y ffmpeg python3-full python3-venv git nodejs

# Get the code
git clone https://github.com/Colimaforever/Methodictruth.git ~/methodictruth
cd ~/methodictruth/chord-server

# Python environment
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Smoke-test before wiring anything up:

```bash
source venv/bin/activate
python app.py           # listens on 127.0.0.1:5005
# in another shell:
curl -s localhost:5005/health
```

`/health` should return JSON with `ok: true`. It also reports
`yt_proxy_configured` and `cookies_present`, which is the fastest way to
confirm your configuration actually took effect.

---

## 4. Configure

Create `/etc/chord-analyzer.env` (root-owned, mode 600 — it may hold proxy
credentials):

```ini
# Residential/ISP proxy for YouTube fetches only.
# HOME SERVER: delete this line entirely — you already have a residential IP.
# CLOUD VM: set it, or expect frequent bot checks (see section 2).
YT_PROXY=http://USER:PASS@residential-endpoint.example:PORT

# Pacing. Defaults are conservative and appropriate for a datacenter IP.
YT_MIN_GAP=20
YT_HOURLY_CAP=12
YT_SLEEP_MIN=1
YT_SLEEP_MAX=5

# Raise on a box with more than 2 cores if you want parallel analyses.
ANALYSIS_SLOTS=1
CACHE_MAX_SONGS=300
```

```bash
sudo chmod 600 /etc/chord-analyzer.env
```

Then in `chord-analyzer.service`, replace the placeholder paths/username and
add the env file:

```ini
EnvironmentFile=/etc/chord-analyzer.env
```

Install and start it:

```bash
sudo cp chord-analyzer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chord-analyzer
systemctl status chord-analyzer
```

Also enable the yt-dlp auto-updater (YouTube breaks yt-dlp regularly; this is
not optional in practice):

```bash
sudo cp yt-dlp-update.service yt-dlp-update.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yt-dlp-update.timer
```

---

## 5. Move the tunnel

This is the step that makes `api.methodictruth.com` point at the new box, and
it's why there is no DNS work.

```bash
# Install cloudflared on the new host
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

Copy the existing tunnel credentials from the WSL2 box (`~/.cloudflared/` —
the `<TUNNEL-ID>.json` credentials file and `config.yml`) to the same path on
the new host. The config's ingress rule stays exactly as it is:

```yaml
ingress:
  - hostname: api.methodictruth.com
    service: http://127.0.0.1:5005
  - service: http_status:404
```

Then:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

**Stop the tunnel on the WSL2 box before or right as you start it here** —
two connectors serving the same hostname will split traffic between them and
make failures look intermittent and impossible to diagnose.

---

## 6. Carry over the state worth keeping

Optional but nice — this preserves everyone's already-analyzed songs, so the
library isn't empty on day one:

```bash
# From the WSL2 box:
rsync -avz ~/path/to/chord-server/cache/ user@NEW_HOST:~/methodictruth/chord-server/cache/

# If you use cookies (see section 2 — throwaway account only):
scp ~/path/to/chord-server/cookies.txt user@NEW_HOST:~/methodictruth/chord-server/
```

`cookies.txt` is gitignored and must stay that way — it is credential
material. Never commit it.

---

## 7. Verify

```bash
# From anywhere — through the tunnel, i.e. the real path a visitor takes:
curl -s https://api.methodictruth.com/health
curl -s https://api.methodictruth.com/library | head -c 300
```

Then in a browser, load `song-analyzer.html` and:

1. **Upload a file.** This exercises analysis end-to-end with no YouTube
   involvement — if this works, the box itself is healthy.
2. **Analyze a YouTube link.** This is the part that depends on IP reputation.
   If it fails, `/health` will tell you whether the proxy is actually
   configured, and the logs will show yt-dlp's specific complaint.
3. Confirm the deep analysis appears (structure blocks, energy curve, key
   confidence) — that confirms you're running the current code, not a stale
   checkout.

Logs live at `chord-server/chord-analyzer.log` (deliberately a file, not
journald — see the long comment in the service unit for why that matters).

---

## 8. Rollback

Because nothing about the frontend or DNS changed, rollback is just moving the
tunnel back: stop `cloudflared` on the new host, start it again on WSL2. The
frontend never knows the difference. Keep the WSL2 install intact until you've
run the new host for a few days.

---

## Firewall note

Nothing needs to be exposed to the internet. The tunnel makes an **outbound**
connection to Cloudflare, and gunicorn binds to `127.0.0.1` only.

- **Cloud VM:** leave the provider firewall closed except SSH — do not open 5005.
- **Home server:** no port forwarding, no router changes, nothing exposed on
  your home connection. This is a real advantage of the tunnel: you get a
  public HTTPS endpoint without opening a single inbound hole in your network.
