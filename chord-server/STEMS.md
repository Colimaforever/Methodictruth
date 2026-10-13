# The stems service — separating a song, then transcribing it

`stems_service.py` splits a track into drums, bass, other and vocals, then
transcribes each part into notes. The analyzer calls it the same way it calls
the lyrics service: one configurable URL, one worker, its own virtualenv.

This is what `amp` was reserved for in `MACHINES.md`.

---

## Why it is worth the trouble

The obvious reason is melody. The better reason is that **separation improves
three things that already exist**:

- **Chords.** Chroma over a full mix is smeared by drums and confused by a
  vocal line. The same detector run on the harmonic stems is reading a cleaner
  signal, with no model change at all.
- **Inversions.** `annotate_bass()` currently *infers* the bass from a
  low-register chroma. An isolated bass stem states it.
- **Transcription.** Polyphonic note detection on a full mix is mud. On a
  separated stem it is usable.

One expensive step, three improvements. That is the argument.

---

## 1. Install, on `amp`

**Install torch first, from the index matching the host's CUDA.** If you let
pip resolve it as a dependency of demucs you get the CPU build — which works,
runs roughly fifty times slower, and gives no error to explain why.

```bash
python3 -m venv ~/stems-venv
~/stems-venv/bin/pip install -U pip
~/stems-venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
~/stems-venv/bin/pip install -r ~/methodictruth/chord-server/requirements-stems.txt
```

Check it found the card before going further:

```bash
~/stems-venv/bin/python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

`False` here means the rest of this document is pointless — fix it now.

### The 4 GB problem

`amp`'s RTX 3050 Ti has 4 GB, and `htdemucs` at its own default wants about 7.
`DEMUCS_SEGMENT` is the knob: it sets how many seconds of audio sit on the card
at once. **7 fits 4 GB.** Lower it if CUDA reports out of memory, raise it on a
bigger card for speed.

This is a batch job, not an interactive one, so a smaller segment costs patience
and nothing else.

---

## 2. The unit

```bash
sed -e 's|REPLACE_WITH_YOUR_USERNAME|amp|g' \
    -e 's|/REPLACE/WITH/PATH/TO/chord-server|/home/amp/methodictruth/chord-server|g' \
    ~/methodictruth/chord-server/stems-service.service \
  | sudo tee /etc/systemd/system/stems-service.service >/dev/null
sudo systemctl daemon-reload && sudo systemctl enable --now stems-service
curl -s localhost:5007/health | python3 -m json.tool
```

`/health` reports every engine it found. A partial install is normal and
survivable — without `basic-pitch` you lose the Keys track and keep the rest —
so read `engines` and `tracks` rather than assuming.

**The first separation downloads the model** (a few hundred MB). Expect the
first request to be slow for a reason that is not your GPU.

---

## 3. Let `chord` reach it

The service binds loopback. To be called from another machine it needs the LAN,
and the LAN needs a firewall rule — the same discipline as the lyrics port, and
for a stronger reason: this endpoint takes a file path, runs two models on it
and writes to disk.

```bash
# on amp
sed -i 's|-b 127.0.0.1:5007|-b 0.0.0.0:5007|' ~/methodictruth/chord-server/stems-service-start.sh
sudo systemctl restart stems-service
sudo ufw allow 22/tcp
sudo ufw allow from 192.168.4.116 to any port 5007 proto tcp
sudo ufw --force enable
```

Then on **`chord`**, in `/etc/chord-analyzer.env`:

```ini
STEMS_ENABLED=1
STEMS_SERVICE_URL=http://192.168.4.165:5007
```

`STEMS_ENABLED` defaults to **off**, deliberately: without a host behind it the
button only ever fails, and a button that always fails is worse than one that is
not there.

### Getting the audio to `amp`

The service is told which file to work on by **absolute path**, which is free
and correct on one machine and meaningless across two — the path resolves to
nothing on `amp`, and every request answers `unknown audio path`.

So requests carry a path *and* a URL, and whichever works is used. Add one line
on each side.

On **`chord`**, in `/etc/chord-analyzer.env`:

```ini
ANALYZER_SELF_URL=http://192.168.4.116:5005
```

On **`amp`**, in the stems unit:

```ini
Environment=FETCH_PREFIX=http://192.168.4.116:5005/audio/
```

`FETCH_PREFIX` is a prefix allow-list, not a toggle. A service that downloads
any URL it is given and then runs two models on it is server-side request
forgery with extra steps, so only URLs beginning with this exact string are ever
fetched, and empty means none are.

`amp` therefore needs to reach gunicorn on `chord`, so the firewall opens in
both directions:

```bash
# on chord
sudo ufw allow from 192.168.4.165 to any port 5005 proto tcp
```

Fetched audio goes to a temp file and is deleted when the response ends. The
stem cache survives it, because stems are keyed on the audio's **content**
rather than its filename — so a song separated from a local path and the same
song fetched over HTTP land on the same cache entry instead of being separated
twice.

NFS would also work and needs no settings at all. It is not worth it here: a
hung mount takes processes with it, and this estate has already lost a boot to
an `fstab` entry for a disk that was not there.

---

## 4. Verify

```bash
# on chord, after analyzing a song in the UI
curl -s localhost:5005/health | python3 -m json.tool | grep stems
curl -s -X POST localhost:5005/stems/<video-id> | python3 -m json.tool | head -40
```

Then in the browser: analyze a song, click **⬇ Full MIDI**, and drag the result
into Logic. You should get Chords, Bass, Melody, Drums as separate tracks, with
the drums on channel 10 so they land on a kit.

---

## What to watch

- **Disk.** Four stems per song, and they are WAVs. `STEMS_CACHE_GB` prunes
  least-recently-used sets once the directory passes its limit. `chord`'s
  256 GB NVMe was already the estate's tightest constraint; this makes it
  tighter.
- **Heat.** `amp` is a laptop. Sustained separation is exactly the load that
  makes a 45 W part throttle in a thin chassis. Check whether a long queue
  actually finishes faster than a short one.
- **The lid.** If `HandleLidSwitch=ignore` is not in place, closing the laptop
  takes the service down mid-job.

## Honest limits

- **Melody extraction will have rough edges.** Vibrato, slides and breathy
  consonants fool pitch trackers. `MIN_NOTE_S` filters the worst of the
  flicker; it cannot invent a note the tracker never held.
- **Drums are three voices.** Kick, snare, hat, split by where the energy sits
  in the first 50 ms. Toms and cymbals are not distinguishable this way, and
  guessing them would be writing a part rather than transcribing one.
- **The Keys track is whatever Demucs could not name.** `other` is a residue
  stem, so on a dense mix it carries guitar, synth, strings and bleed together,
  and `basic-pitch` transcribes all of it.
