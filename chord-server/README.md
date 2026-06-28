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
pip install --break-system-packages -r requirements.txt
```

## 2. Run it

```bash
source venv/bin/activate
python app.py
# listens on http://127.0.0.1:5005
```

Test it:

```bash
curl -X POST http://127.0.0.1:5005 \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

A 3-4 minute song takes roughly 10-30 seconds to analyze (download + librosa),
not 1-2 minutes — that loading copy in the frontend was a conservative
estimate from the original mock-data version.

## 3. Run it as a service (so it survives reboots)

Edit `chord-analyzer.service`, replacing `/REPLACE/WITH/PATH/TO/chord-server`
with the actual path, then:

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
