# Splitting the analyzer across two machines

Moving the **CPU half** of the analyzer to its own box and leaving only the
**GPU half** on the XPS. This is a deployment change, not a code change —
nothing in this directory needs editing to make it work.

> `MIGRATION.md` is about moving the *whole* analyzer to a new host. This is
> about running it on two hosts at once. Read that one first if you are also
> changing where the tunnel lives; the tunnel section here assumes you know it.

---

## Why it splits cleanly

`app.py` has **no torch and no CUDA**. Its entire requirements file is Flask,
gunicorn, yt-dlp, librosa, numpy, scipy, soundfile — all CPU work. The only
GPU-dependent part of the system lives in `lyrics_service.py`, which is already
a separate process, a separate systemd unit and a separate virtualenv.

They talk over one configurable address:

```python
LYRICS_URL = os.environ.get('LYRICS_SERVICE_URL', 'http://127.0.0.1:5006')
```

That default is the only reason both halves currently share a machine. Point it
across the network and the split is done.

**What each box ends up doing:**

| | Runs | Why there |
| --- | --- | --- |
| **New box** (OptiPlex 3000 Micro, i5-12th gen 6C/12T, 32 GB) | `app.py` under gunicorn, yt-dlp, ffmpeg, the PO-token server, cloudflared | Download, decode, librosa analysis, chord decoding and pitch renders are all CPU. Quick Sync does the ffmpeg passes in hardware |
| **XPS** (CUDA) | `lyrics_service.py` only | Whisper `large-v3` is the one thing that genuinely needs the GPU |

The gain is not raw speed — it is that `ANALYSIS_SLOTS` stops competing with
everything else on one box, and the XPS idles until someone actually asks for
lyrics.

---

## 1. Stage the new host

Ubuntu **Server** (not Desktop). Match the XPS's release if you can:

```bash
ssh <xps> 'lsb_release -ds; python3 -V'
```

Prefer the LTS whose Python has prebuilt wheels for `librosa`, `numpy`, `scipy`
and `soundfile` — on a very new Python, pip falls back to compiling from source
and can simply fail. 24.04 LTS ships Python 3.12, where all four have wheels.

At the installer:

- **Install OpenSSH server**, and import your public key there. Do not leave
  this until the box is already unreachable.
- **No full-disk encryption.** On a headless always-on machine LUKS means it
  will not boot without someone at a monitor typing a passphrase.
- **Single NVMe, nothing extra in `/etc/fstab`.** A drive listed there that is
  not present will hang the boot — that is what happened to the XPS.
- Give it a **static IP or a DHCP reservation**. Two things will point at
  addresses after this, and a changed lease breaks both silently.

Then the standard install from `MIGRATION.md` §3 — `ffmpeg`, `python3-full`,
`python3-venv`, `git`, `nodejs`, clone, venv, `pip install -r requirements.txt`.

---

## 2. Point it at the GPU box

On the **new box**, in `/etc/chord-analyzer.env` (mode `600`):

```ini
LYRICS_SERVICE_URL=http://<xps-ip>:5006
ANALYSIS_SLOTS=3
```

`ANALYSIS_SLOTS=3` is the point of the exercise. It was 1 because analysis had
to share a box with the GPU service; on 6 cores with nothing else competing,
three concurrent analyses leave headroom for the box to still answer `/health`.
Raise it to 4 only after watching `%(M)s` in the access log under real load.

**Bass detection also wants these cores.** It runs a second CQT over the bass
register so the analyzer can hear inversions, which is the one measurement that
improves the chord chart, the shapes and the MIDI export together. It is on by
default and tunable:

| Variable | Default | What it does |
| --- | --- | --- |
| `BASS_DETECTION` | `0` | **Off until you have heard it.** `1` enables it |
| `BASS_MARGIN` | `1.25` | How far the winning bass pitch class must beat the runner-up before an inversion is reported |
| `BASS_OUTSIDE_MARGIN` | `1.8` | The higher bar a bass note outside the chord has to clear |

Raise the margins if slashes start appearing on chords that are plainly in root
position; lower them if obvious inversions are being missed. Nothing here can
change a chord *label* — only add a bass note to it — so the worst a bad setting
costs is a wrong slash.

Load the env file from the unit:

```ini
[Service]
EnvironmentFile=/etc/chord-analyzer.env
```

On the **XPS**, the lyrics service must now listen on the LAN rather than
loopback. The bind address is in **`lyrics-service-start.sh`**, not the unit
file — its last line is:

```bash
exec "$VENV/bin/gunicorn" -w 1 --timeout 600 \
     -b 127.0.0.1:5006 lyrics_service:app
```

Change that to `-b 0.0.0.0:5006`, leave `-w 1` alone (one worker is what keeps a
single ~3 GB model resident on a 6 GB card and serializes GPU access without a
lock), then firewall the port to the one host allowed to reach it:

```bash
sudo ufw allow from <new-box-ip> to any port 5006 proto tcp
sudo ufw --force enable
```

**Do not skip the ufw rule.** The lyrics endpoint takes an audio file and runs a
model on it; on loopback that was nobody's business but the box's, and on the
LAN it is reachable by anything on the network.

---

## 3. Move the tunnel

The tunnel is what decides which machine is "the analyzer" — it is an outbound
connection identified by a credentials file, not by an IP, so moving it is a
copy and a restart.

```bash
# on the new box
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

Copy `~/.cloudflared/` from the XPS — the `<TUNNEL-ID>.json` credentials and
`config.yml`. The ingress rule is unchanged: it still points at
`http://127.0.0.1:5005`, which is now gunicorn on *this* box.

**Run only one at a time.** Two cloudflared instances with the same credentials
will both connect and Cloudflare will load-balance between them, so requests
land on whichever machine answers — which during a cutover means half your
traffic hits the host you are still configuring.

```bash
sudo systemctl stop cloudflared          # on the XPS, first
sudo cloudflared service install          # on the new box, second
```

---

## 4. Cut over, and how to go back

Build the new box alongside the old one and leave the XPS running the full
stack until the moment you switch. The tunnel is the switch.

```
┌─ before ──────────────┐     ┌─ after ───────────────────────────┐
│ XPS: app + lyrics     │     │ OptiPlex: app  ──5006──►  XPS:     │
│      + tunnel         │     │           + tunnel        lyrics   │
└───────────────────────┘     └────────────────────────────────────┘
```

Verify in this order, and stop at the first thing that fails:

```bash
# on the new box, before the tunnel moves
curl -s localhost:5005/health | python3 -m json.tool
#   ok: true, ffmpeg: true, lyrics_service_up: true  <- proves the LAN hop works
#   lyrics_service_up:false here means the XPS bind or the ufw rule is wrong

# after the tunnel moves
curl -s https://api.methodictruth.com/health | python3 -m json.tool
```

Then analyze one song end to end on the live site, and transcribe its lyrics —
that is the only test that exercises both machines.

**Rollback is one command.** Stop cloudflared on the new box, start it on the
XPS, and set `LYRICS_SERVICE_URL` back to `http://127.0.0.1:5006` there. The XPS
still has the whole stack installed; nothing was removed from it. Keep it that
way for a couple of weeks.

---

## 5. What to watch afterwards

- **Disk.** 256 GB is the real constraint. The cache is mp3s and pruned LRU;
  watch `cached_songs` in `/health` and `df -h`. A 1 TB M.2 2230 is the cheapest
  fix if it becomes tight.
- **The LAN hop.** `lyrics_service_up` in `/health` now means "the XPS is
  reachable and answering", not "a local process is alive". The uptime alert
  already treats a down sidecar as *degraded* rather than *down*, which is the
  right severity: the site and the analyzer still work, lyrics do not.
- **Whether the XPS can sleep.** It now has one job and no reason to be awake
  between transcriptions. Wake-on-LAN from the new box before a lyrics request
  would make it genuinely idle — worth doing only if the fan noise bothers you,
  because it adds a cold-start delay to the first transcription.

## Not worth doing

Running Whisper on the new box's iGPU. `large-v3` on a 12th-gen CPU is minutes
where the XPS takes seconds. Worth installing *only* as a fallback so lyrics
degrade to slow rather than dead when the XPS is off — never as the primary.
