"""
Stem separation and note transcription sidecar for the Song Analyzer.

Same shape as lyrics_service.py and for the same reasons: a separate process,
a separate virtualenv, a single gunicorn worker. One worker is what keeps one
copy of Demucs on the card and serialises GPU access without a lock.

What it is for
--------------
The analyzer reports chord *symbols*. That answers "what harmony is this" and
not "what was played". Separating the song first and transcribing each part
answers the second question, and improves the answer to the first: chroma
computed on the harmonic stems alone is not smeared by drums or confused by a
vocal line, and an isolated bass stem states the inversion instead of implying
it.

So separation is not only how melody gets extracted. It is the one expensive
step that makes three existing features better.

What it returns
---------------
Note lists as JSON, not a MIDI file. The browser already knows how to write a
Standard MIDI File (midi-export.js) and already holds the chord track, so
keeping all MIDI writing in one place means the two can never disagree about
tempo, grid or key. This service transcribes; it does not serialise.

Degrading gracefully
--------------------
Every stage is optional and independently detected. A box with Demucs but no
basic-pitch still returns melody, bass and drums. /health says exactly which
engines are present, so a partial install is a visible state rather than a
confusing one -- which matters, because this dependency stack is large and
half-installed is its most likely condition.

Run with:
    ~/stems-venv/bin/gunicorn -w 1 --timeout 1800 -b 127.0.0.1:5007 stems_service:app
"""
import hashlib
import json
import os
import shutil
import subprocess
import time

from flask import Flask, Response, jsonify, request

import sidecar_io

app = Flask(__name__)

# Only files under here may be read. The path arrives over HTTP, so without
# this a crafted value could reach anything the service user can.
CACHE_DIR = os.path.realpath(
    os.environ.get('CACHE_DIR',
                   os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')))

# Separated stems live here. They are large and reusable: expensive once,
# free forever after, which is the entire economics of this service.
STEMS_DIR = os.path.realpath(
    os.environ.get('STEMS_DIR',
                   os.path.join(os.path.dirname(os.path.abspath(__file__)), 'stems')))

# Set this when the analyzer is on a different machine, to the prefix its audio
# endpoint sits behind -- e.g. http://192.168.4.116:5005/audio/. This is the
# usual case for this service, since separation wants a GPU and chord detection
# does not, so the two halves rarely share a disk. See sidecar_io.
FETCH_PREFIX = os.environ.get('FETCH_PREFIX', '')

DEMUCS_MODEL = os.environ.get('DEMUCS_MODEL', 'htdemucs')
DEMUCS_DEVICE = os.environ.get('DEMUCS_DEVICE', 'cuda')

# Demucs holds one segment of audio on the card at a time, so this is the knob
# that decides whether it fits in VRAM. The default model wants ~7 GB at its
# own default; 7 seconds fits comfortably in 4 GB. Lower it if you see CUDA
# out-of-memory, raise it on a bigger card for speed.
DEMUCS_SEGMENT = os.environ.get('DEMUCS_SEGMENT', '7')

# How much disk the stem cache may use before the least recently used sets are
# pruned. Four stems per song is roughly 4x the source audio, so this fills
# faster than the mp3 cache it sits beside.
STEMS_CACHE_GB = float(os.environ.get('STEMS_CACHE_GB', '40'))

# Notes shorter than this are tracking artifacts, not performance. Pitch
# trackers flicker for a frame or two at note boundaries and during consonants;
# without a floor the melody track fills with 30 ms grace notes that no one
# played.
MIN_NOTE_S = float(os.environ.get('MIN_NOTE_S', '0.08'))

# A pitch tracker's confidence below which a frame is treated as silence.
VOICED_MIN = float(os.environ.get('VOICED_MIN', '0.5'))

SR = 22050

_engines = None


# ─── engine discovery ──────────────────────────────────────────────────────

def engines():
    # Probed once and cached. Each entry is independently useful, so a missing
    # one costs its own track and nothing else.
    global _engines
    if _engines is not None:
        return _engines

    found = {}

    found['demucs'] = shutil.which('demucs') is not None
    if not found['demucs']:
        try:
            import demucs.separate  # noqa: F401
            found['demucs'] = True
        except Exception:
            found['demucs'] = False

    for name, module in (('librosa', 'librosa'), ('basic_pitch', 'basic_pitch'),
                         ('crepe', 'crepe'), ('torch', 'torch')):
        try:
            __import__(module)
            found[name] = True
        except Exception:
            found[name] = False

    found['cuda'] = False
    if found['torch']:
        try:
            import torch
            found['cuda'] = bool(torch.cuda.is_available())
        except Exception:
            found['cuda'] = False

    _engines = found
    return found


# ─── paths ─────────────────────────────────────────────────────────────────

def _has_source(body):
    # Is there anything here this host could actually read? Either a path that
    # resolves locally, or a URL it is permitted to fetch.
    if sidecar_io.resolve_local((body or {}).get('path'), CACHE_DIR):
        return True
    url = ((body or {}).get('url') or '').strip()
    return bool(url and FETCH_PREFIX and url.startswith(FETCH_PREFIX))


def _stem_key(path):
    # Keyed on the audio's CONTENT, never its name. A fetched copy lands in a
    # temp file called 'audio' while the same song read locally is '<id>.mp3';
    # hashing the name would make those two different songs and separate the
    # same audio twice. Size plus the first megabyte distinguishes real tracks
    # without reading hundreds of megabytes to find out.
    h = hashlib.sha1()
    h.update(str(os.stat(path).st_size).encode())
    with open(path, 'rb') as fh:
        h.update(fh.read(1 << 20))
    return h.hexdigest()[:16]


def _dir_size(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def prune_stems():
    # Least-recently-used by directory mtime. Called after a successful
    # separation, so the cache is trimmed when it grows rather than on a timer
    # that might run while something is reading.
    limit = STEMS_CACHE_GB * (1 << 30)
    if not os.path.isdir(STEMS_DIR):
        return 0
    entries = []
    for name in os.listdir(STEMS_DIR):
        p = os.path.join(STEMS_DIR, name)
        if os.path.isdir(p):
            entries.append((os.path.getmtime(p), p))
    total = _dir_size(STEMS_DIR)
    removed = 0
    for _mtime, p in sorted(entries):
        if total <= limit:
            break
        size = _dir_size(p)
        shutil.rmtree(p, ignore_errors=True)
        total -= size
        removed += 1
    return removed


# ─── separation ────────────────────────────────────────────────────────────

def separate(path, progress=None):
    """Split into drums/bass/other/vocals, cached. Returns {name: wav path}."""
    key = _stem_key(path)
    out_dir = os.path.join(STEMS_DIR, key)
    wanted = ('drums', 'bass', 'other', 'vocals')

    existing = {n: os.path.join(out_dir, n + '.wav') for n in wanted}
    if all(os.path.isfile(p) for p in existing.values()):
        os.utime(out_dir, None)                      # keep LRU honest
        if progress:
            progress('cached', 'stems already separated')
        return existing

    if not engines()['demucs']:
        raise RuntimeError('demucs is not installed on this host')

    os.makedirs(out_dir, exist_ok=True)
    if progress:
        progress('separating', f'{DEMUCS_MODEL} on {DEMUCS_DEVICE}')

    # Demucs writes to <out>/<model>/<track name>/<stem>.wav. Pointing it at a
    # temp directory and flattening afterwards keeps our own layout stable
    # across Demucs versions, which have moved this around before.
    tmp = os.path.join(out_dir, '_raw')
    cmd = ['demucs', '-n', DEMUCS_MODEL, '-d', DEMUCS_DEVICE,
           '--segment', str(DEMUCS_SEGMENT), '-o', tmp, path]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        shutil.rmtree(out_dir, ignore_errors=True)
        tail = (proc.stderr or proc.stdout or '').strip().splitlines()[-4:]
        raise RuntimeError('demucs failed: ' + ' / '.join(tail))

    for root, _dirs, files in os.walk(tmp):
        for f in files:
            stem = os.path.splitext(f)[0]
            if stem in wanted:
                shutil.move(os.path.join(root, f), os.path.join(out_dir, stem + '.wav'))
    shutil.rmtree(tmp, ignore_errors=True)

    missing = [n for n, p in existing.items() if not os.path.isfile(p)]
    if missing:
        raise RuntimeError('demucs produced no ' + ', '.join(missing))

    prune_stems()
    return existing


# ─── note extraction ───────────────────────────────────────────────────────

def _segment_notes(times, midi, voiced, min_s=None):
    """Runs of one semitone become notes. Shared by every monophonic path."""
    import numpy as np
    min_s = MIN_NOTE_S if min_s is None else min_s

    notes = []
    start = None
    pitch = None
    for i in range(len(midi)):
        p = int(round(midi[i])) if voiced[i] and np.isfinite(midi[i]) else None
        if p != pitch:
            if pitch is not None and start is not None:
                dur = times[i] - times[start]
                if dur >= min_s:
                    notes.append({'pitch': pitch,
                                  'start': round(float(times[start]), 3),
                                  'end': round(float(times[i]), 3)})
            pitch, start = p, i
    if pitch is not None and start is not None and len(times) > start + 1:
        dur = times[-1] - times[start]
        if dur >= min_s:
            notes.append({'pitch': pitch,
                          'start': round(float(times[start]), 3),
                          'end': round(float(times[-1]), 3)})
    return notes


def track_monophonic(wav, fmin, fmax, prefer_crepe=False):
    """One line at a time: a bass part or a sung melody."""
    import numpy as np
    import librosa

    y, sr = librosa.load(wav, sr=SR, mono=True)
    if len(y) < sr // 4:
        return []

    if prefer_crepe and engines()['crepe']:
        # CREPE is the better tracker on voice -- it holds pitch through
        # vibrato and breath where autocorrelation methods drop out -- but it
        # is a neural net, so it only earns its cost on the vocal stem.
        import crepe
        t, f, conf, _ = crepe.predict(y, sr, viterbi=True, step_size=20, verbose=0)
        f = np.asarray(f, dtype=float)
        voiced = (np.asarray(conf) >= VOICED_MIN) & (f >= fmin) & (f <= fmax)
        with np.errstate(divide='ignore', invalid='ignore'):
            midi = librosa.hz_to_midi(np.where(f > 0, f, np.nan))
        return _segment_notes(np.asarray(t, dtype=float), midi, voiced)

    f0, voiced_flag, voiced_prob = librosa.pyin(
        y, fmin=fmin, fmax=fmax, sr=sr, frame_length=2048)
    times = librosa.times_like(f0, sr=sr)
    voiced = np.asarray(voiced_flag) & (np.asarray(voiced_prob) >= VOICED_MIN)
    with np.errstate(invalid='ignore'):
        midi = librosa.hz_to_midi(f0)
    return _segment_notes(times, midi, voiced)


def track_polyphonic(wav):
    """Several notes at once: the keys/guitar stem."""
    if not engines()['basic_pitch']:
        return []
    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH

    _model_out, _midi, note_events = predict(wav, ICASSP_2022_MODEL_PATH)
    notes = []
    for ev in note_events:
        start, end, pitch = float(ev[0]), float(ev[1]), int(ev[2])
        if end - start < MIN_NOTE_S:
            continue
        notes.append({'pitch': pitch, 'start': round(start, 3), 'end': round(end, 3)})
    notes.sort(key=lambda n: (n['start'], n['pitch']))
    return notes


# General MIDI drum map. Three voices is the honest limit of what a spectral
# split can distinguish; pretending to hear toms and rides from band energy
# would be inventing a part rather than transcribing one.
GM_KICK, GM_SNARE, GM_HAT = 36, 38, 42


def track_drums(wav):
    import numpy as np
    import librosa

    y, sr = librosa.load(wav, sr=SR, mono=True)
    if len(y) < sr // 4:
        return []

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr,
                                        backtrack=True, units='frames')
    if not len(frames):
        return []
    times = librosa.frames_to_time(frames, sr=sr)

    # Classify each hit by where its energy sits in the first 50 ms. A kick is
    # almost entirely low, a hat almost entirely high, and a snare is the
    # broadband thing in between.
    notes = []
    win = int(0.05 * sr)
    for t in times:
        a = int(t * sr)
        seg = y[a:a + win]
        if len(seg) < 64:
            continue
        S = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        freqs = np.fft.rfftfreq(len(seg), 1 / sr)
        low = S[freqs < 150].sum()
        mid = S[(freqs >= 150) & (freqs < 2000)].sum()
        high = S[freqs >= 2000].sum()
        total = low + mid + high
        if total <= 0:
            continue
        if low / total > 0.5:
            pitch = GM_KICK
        elif high / total > 0.5:
            pitch = GM_HAT
        else:
            pitch = GM_SNARE
        notes.append({'pitch': pitch, 'start': round(float(t), 3),
                      'end': round(float(t) + 0.1, 3)})
    return notes


# ─── the job ───────────────────────────────────────────────────────────────

# Each track names the stem it comes from, the method, and the pitch range it
# is allowed to report. The ranges matter: a bass tracker given a full range
# will happily report octave errors an octave up, and constraining it is
# cheaper and more reliable than trying to correct them afterwards.
TRACKS = [
    {'name': 'Bass',   'stem': 'bass',   'kind': 'mono', 'fmin': 30.0,  'fmax': 400.0},
    {'name': 'Melody', 'stem': 'vocals', 'kind': 'mono', 'fmin': 80.0,  'fmax': 1200.0,
     'crepe': True},
    {'name': 'Keys',   'stem': 'other',  'kind': 'poly'},
    {'name': 'Drums',  'stem': 'drums',  'kind': 'drums'},
]


def transcribe(path, want=None, progress=None):
    stems = separate(path, progress=progress)
    out = []
    for spec in TRACKS:
        if want and spec['name'].lower() not in want:
            continue
        wav = stems.get(spec['stem'])
        if not wav or not os.path.isfile(wav):
            continue
        if progress:
            progress('transcribing', spec['name'])
        t0 = time.time()
        try:
            if spec['kind'] == 'mono':
                notes = track_monophonic(wav, spec['fmin'], spec['fmax'],
                                         prefer_crepe=spec.get('crepe', False))
            elif spec['kind'] == 'poly':
                notes = track_polyphonic(wav)
            else:
                notes = track_drums(wav)
        except Exception as exc:  # one track failing must not lose the rest
            app.logger.exception('%s transcription failed', spec['name'])
            out.append({'name': spec['name'], 'notes': [],
                        'error': f'{type(exc).__name__}: {exc}'})
            continue
        out.append({'name': spec['name'], 'notes': notes,
                    'drums': spec['kind'] == 'drums',
                    'elapsed': round(time.time() - t0, 1)})
    return out


# ─── HTTP ──────────────────────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    e = engines()
    cached = 0
    if os.path.isdir(STEMS_DIR):
        cached = sum(1 for n in os.listdir(STEMS_DIR)
                     if os.path.isdir(os.path.join(STEMS_DIR, n)))
    return jsonify(
        ok=e['demucs'] and e['librosa'],
        engines=e,
        model=DEMUCS_MODEL,
        device=DEMUCS_DEVICE,
        segment=DEMUCS_SEGMENT,
        # Which tracks this host can actually produce right now, so a caller
        # can grey out what is unavailable instead of asking and failing.
        tracks=[t['name'] for t in TRACKS
                if t['kind'] != 'poly' or e['basic_pitch']],
        cached_stem_sets=cached,
        stems_dir_gb=round(_dir_size(STEMS_DIR) / (1 << 30), 2) if os.path.isdir(STEMS_DIR) else 0,
    )


@app.route('/stems', methods=['POST'])
def stems_only():
    # Separation without transcription. The analyzer wants this on its own:
    # chroma computed on bass+other, with drums and vocals removed, is a
    # better chord reading than the full mix at no extra separation cost.
    body = request.get_json(silent=True) or {}
    try:
        with sidecar_io.source(body, CACHE_DIR, FETCH_PREFIX) as real:
            if real is None:
                return jsonify(ok=False, error='unknown audio path'), 404
            stems = separate(real)
    except Exception as exc:  # noqa: BLE001
        app.logger.exception('separation failed')
        return jsonify(ok=False, error=f'{type(exc).__name__}: {exc}'), 500
    return jsonify(ok=True, stems=stems)


@app.route('/transcribe-stream', methods=['POST'])
def transcribe_stream():
    # Newline-delimited JSON, same as the lyrics service and for the same
    # reason: this runs for minutes, and a synchronous response would sit
    # silent long past any proxy's patience.
    body = request.get_json(silent=True) or {}
    if not _has_source(body):
        return jsonify(ok=False, error='unknown audio path'), 404
    want = set(w.lower() for w in (body.get('tracks') or [])) or None

    def gen():
        t0 = time.time()
        lines = []

        def progress(stage, detail):
            lines.append(json.dumps({'type': 'progress', 'stage': stage, 'detail': detail}))

        try:
            yield json.dumps({'type': 'start', 'model': DEMUCS_MODEL}) + '\n'
            # Opened here, not in the view: a fetched file has to outlive the
            # view call and be removed once the response is done.
            with sidecar_io.source(body, CACHE_DIR, FETCH_PREFIX) as real:
                if real is None:
                    yield json.dumps({'type': 'error', 'error': 'audio unavailable'}) + '\n'
                    return
                tracks = transcribe(real, want=want, progress=progress)
            for line in lines:
                yield line + '\n'
            yield json.dumps({
                'type': 'done',
                'tracks': tracks,
                'elapsed': round(time.time() - t0, 1),
            }) + '\n'
        except Exception as exc:  # noqa: BLE001
            app.logger.exception('transcription failed')
            yield json.dumps({'type': 'error',
                              'error': f'{type(exc).__name__}: {exc}'}) + '\n'

    return Response(gen(), mimetype='application/x-ndjson')


@app.route('/transcribe', methods=['POST'])
def transcribe_buffered():
    body = request.get_json(silent=True) or {}
    want = set(w.lower() for w in (body.get('tracks') or [])) or None
    t0 = time.time()
    try:
        with sidecar_io.source(body, CACHE_DIR, FETCH_PREFIX) as real:
            if real is None:
                return jsonify(ok=False, error='unknown audio path'), 404
            tracks = transcribe(real, want=want)
    except Exception as exc:  # noqa: BLE001
        app.logger.exception('transcription failed')
        return jsonify(ok=False, error=f'{type(exc).__name__}: {exc}'), 500
    return jsonify(ok=True, tracks=tracks, elapsed=round(time.time() - t0, 1))


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5007)
