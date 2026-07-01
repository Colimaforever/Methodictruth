"""
Local chord-detection backend for the Song Analyzer tool.

Downloads a YouTube video's audio, then uses librosa to detect tempo (BPM),
key, and a chord progression with timestamps. Replaces the mock data
currently served by worker/song-analyzer-worker.js.

Run with: python app.py
"""
import faulthandler
import fcntl
import json
import os
import queue
import re
import shutil
import signal
import sys
import tempfile
import threading
import time
from contextlib import contextmanager

import librosa
import numpy as np
import yt_dlp
from flask import (Flask, abort, jsonify, request, send_file,
                   stream_with_context)

app = Flask(__name__)

# `kill -USR2 <worker_pid>` dumps that worker's Python stack (all threads) to
# stderr -> the log file, without killing it. Lets us catch exactly where a
# request is frozen instead of guessing from where the timeout abort landed.
faulthandler.register(signal.SIGUSR2, all_threads=True, chain=False)

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

# Cap how many analyses run concurrently across ALL gunicorn workers. A single
# download+librosa analysis is CPU-heavy; letting every worker run one at once
# thrashes the box so badly that requests stall and time out (each one runs
# fine in isolation). Overlapping requests instead queue for a slot and run in
# the same clean conditions. Default 1 (fully serialized) is rock-solid for a
# personal/low-traffic tool; raise ANALYSIS_SLOTS on a beefier box.
ANALYSIS_SLOTS = max(1, int(os.environ.get('ANALYSIS_SLOTS', '1')))

# Keep the cache from growing without bound: each analyzed song leaves a few-MB
# MP3 on disk forever. Once there are more than this many, drop the
# least-recently-used ones (MP3 + its .json) so the disk can't silently fill.
CACHE_MAX_SONGS = max(10, int(os.environ.get('CACHE_MAX_SONGS', '300')))

# How long a streaming request will wait before bailing out with a clean
# message. Kept well under gunicorn's --timeout so a throttled/stuck download
# returns a helpful error instead of silently dropping the connection when the
# worker is killed. The background analysis keeps running and caches its result,
# so a retry lands instantly.
STREAM_DEADLINE = max(30, int(os.environ.get('STREAM_DEADLINE', '100')))


def prune_cache():
    # Best-effort LRU trim; never let a cleanup error break a request.
    try:
        mp3s = [os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR)
                if f.endswith('.mp3')]
        if len(mp3s) <= CACHE_MAX_SONGS:
            return
        mp3s.sort(key=os.path.getmtime)  # oldest (least recently used) first
        for path in mp3s[:len(mp3s) - CACHE_MAX_SONGS]:
            vid = os.path.basename(path)[:-4]
            for ext in ('.mp3', '.json'):
                try:
                    os.remove(os.path.join(CACHE_DIR, vid + ext))
                except OSError:
                    pass
    except OSError:
        pass


@contextmanager
def analysis_slot():
    # Cross-process semaphore built on flock: grab the first free slot file,
    # else poll until one frees. flock is released automatically if a worker
    # dies, so a crashed/killed request never leaks a slot permanently.
    held = None
    try:
        while held is None:
            for i in range(ANALYSIS_SLOTS):
                cand = open(os.path.join(CACHE_DIR, f'.slot-{i}.lock'), 'w')
                try:
                    fcntl.flock(cand, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    held = cand
                    break
                except BlockingIOError:
                    cand.close()
            if held is None:
                time.sleep(0.5)
        yield
    finally:
        if held is not None:
            fcntl.flock(held, fcntl.LOCK_UN)
            held.close()

NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Triad templates only — all three notes, so cosine matching compares them on
# equal footing with no bias toward "bigger" chords. (An earlier attempt mixed
# triads and four-note seventh templates; on real chroma, where energy is spread
# across every pitch class by harmonics/bass/vocals, the four-note templates
# captured more total energy and won almost everywhere, labelling everything a
# 7th.) Sevenths are instead decided in a cheap second pass that checks whether
# the 7th degree actually carries energy — so we report clean triads by default
# and a 7th only when it's genuinely being played.
TRIAD_QUALITIES = {
    '':  (0, 4, 7),   # major
    'm': (0, 3, 7),   # minor
    # Only the two unambiguous triads. sus2/sus4 (one semitone off major) and
    # diminished (one semitone off minor) all sit a single semitone from these,
    # so chroma template matching flips onto them on noise and litters the chart
    # with phantom chords — e.g. a plain Fm reads as "Fdim" whenever the b5 has
    # stray energy. Major/minor plus the energy-grounded 7th pass below is the
    # robust core; richer/ambiguous qualities need a sequence model (HMM/Viterbi
    # or madmom), noted as a future upgrade.
}
_TRIAD_VECS, _TRIAD_ROOT, _TRIAD_QUAL = [], [], []
for _i in range(12):
    for _suffix, _intervals in TRIAD_QUALITIES.items():
        _vec = np.zeros(12)
        for _iv in _intervals:
            _vec[(_i + _iv) % 12] = 1.0
        _TRIAD_VECS.append(_vec / np.linalg.norm(_vec))
        _TRIAD_ROOT.append(_i)
        _TRIAD_QUAL.append(_suffix)
_TRIAD_MATRIX = np.array(_TRIAD_VECS)

# How strong the 7th must be, relative to the average triad-tone energy, before
# we promote a chord to a seventh. Conservative, so we don't hallucinate them.
SEVENTH_RATIO = 0.85

# Krumhansl-Schmuckler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

YOUTUBE_RE = re.compile(r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([^&?/]+)')


def extract_video_id(url):
    match = YOUTUBE_RE.search(url)
    return match.group(1) if match else None


def detect_key(chroma_mean):
    best_score, best_key = -1, 'C Major'
    for i in range(12):
        major_score = np.corrcoef(chroma_mean, np.roll(MAJOR_PROFILE, i))[0, 1]
        if major_score > best_score:
            best_score, best_key = major_score, f'{NOTES[i]} Major'
        minor_score = np.corrcoef(chroma_mean, np.roll(MINOR_PROFILE, i))[0, 1]
        if minor_score > best_score:
            best_score, best_key = minor_score, f'{NOTES[i]} Minor'
    return best_key


def _classify_column(col):
    # Stage 1: best-matching triad (fair, all three-note). Stage 2: add a 7th
    # only on major/minor triads, and only when that degree's energy is
    # comparable to the chord tones — otherwise keep the clean triad.
    norm = np.linalg.norm(col)
    if norm == 0:
        return None
    k = int(np.argmax(_TRIAD_MATRIX @ (col / norm)))
    root, qual = _TRIAD_ROOT[k], _TRIAD_QUAL[k]
    name = f'{NOTES[root]}{qual}'
    if qual in ('', 'm'):
        triad_mean = np.mean([col[(root + t) % 12] for t in TRIAD_QUALITIES[qual]])
        # Only the *flat* 7th (dominant-7 on a major triad, minor-7 on a minor
        # triad) — it's a structural chord tone. We intentionally don't detect
        # the major-7th: it's the leading tone, present in nearly every major-key
        # melody, so it would tag almost every tonic chord as maj7.
        if triad_mean > 0 and col[(root + 10) % 12] >= SEVENTH_RATIO * triad_mean:
            name += '7'               # C7 (major) or Cm7 (minor)
    return name


def _classify_columns(cols):
    return [_classify_column(cols[:, j]) for j in range(cols.shape[1])]


def _smooth_labels(labels, window=1):
    # Mode filter over a +/-window neighbourhood: a lone out-of-place label in
    # an "A A B A A" run gets absorbed back to A, removing one-beat flicker that
    # template matching produces on transients.
    if window < 1:
        return labels
    out, n = [], len(labels)
    for i in range(n):
        counts = {}
        for k in range(max(0, i - window), min(n, i + window + 1)):
            lab = labels[k]
            if lab is not None:
                counts[lab] = counts.get(lab, 0) + 1
        out.append(max(counts, key=counts.get) if counts else labels[i])
    return out


def detect_chords(chroma, sr, beat_frames=None, hop_length=512):
    # Beat-synchronous when possible: aggregate the chroma over each beat so a
    # detected chord lands on the musical grid instead of an arbitrary 2-second
    # window. Falls back to fixed windows when beat tracking found too few beats.
    if beat_frames is not None and len(beat_frames) >= 6:
        # Aggregate over half-bars (every other beat): pop chords rarely change
        # faster than that, so this removes most beat-to-beat flicker up front.
        bounds = np.asarray(beat_frames)[::2]
        cols = librosa.util.sync(chroma, bounds, aggregate=np.median)
        times = librosa.frames_to_time(np.concatenate([[0], bounds]), sr=sr, hop_length=hop_length)
    else:
        fps = max(1, int(2.0 * sr / hop_length))
        starts = list(range(0, chroma.shape[1], fps))
        cols = np.stack([chroma[:, s:s + fps].mean(axis=1) for s in starts], axis=1)
        times = librosa.frames_to_time(np.array(starts), sr=sr, hop_length=hop_length)

    # window=2 (a 5-segment mode filter) leans on chords persisting across a bar
    # or so, absorbing isolated noisy segments into their neighbours.
    labels = _smooth_labels(_classify_columns(cols), window=2)

    chords, last = [], None
    for j in range(min(len(labels), len(times))):
        lab = labels[j]
        if lab is None or lab == last:
            continue
        chords.append({'chord': lab, 'timestamp': round(float(times[j]), 2)})
        last = lab
    return chords


def build_measures(beat_frames, chords, sr, hop_length=512, beats_per_bar=4):
    # Turn the flat chord-change list into a bar-by-bar chart — how a musician
    # actually reads a song ("4 bars of Fm, then Db–Eb"). Assumes 4/4 and picks
    # the bar phase that best lines bar starts up with real chord changes, so
    # the grid matches the song's harmonic rhythm instead of an arbitrary offset.
    if beat_frames is None or len(beat_frames) < beats_per_bar + 1 or not chords:
        return []
    beat_times = librosa.frames_to_time(np.asarray(beat_frames), sr=sr, hop_length=hop_length)
    change_times = [c['timestamp'] for c in chords]
    names = [c['chord'] for c in chords]

    def chord_at(t):
        active = names[0]
        for ct, nm in zip(change_times, names):
            if ct <= t + 1e-6:
                active = nm
            else:
                break
        return active

    beat_period = float(np.median(np.diff(beat_times))) if len(beat_times) > 1 else 0.5
    tol = beat_period * 0.5
    best_phase, best_hits = 0, -1
    for phase in range(beats_per_bar):
        starts = beat_times[phase::beats_per_bar]
        if len(starts) == 0:
            continue
        hits = sum(1 for ct in change_times if np.min(np.abs(starts - ct)) <= tol)
        if hits > best_hits:
            best_hits, best_phase = hits, phase

    measures = []
    for n, b in enumerate(range(best_phase, len(beat_times) - 1, beats_per_bar)):
        start = float(beat_times[b])
        end = float(beat_times[min(b + beats_per_bar, len(beat_times) - 1)])
        bar = [chord_at(start)]
        for ct, nm in zip(change_times, names):
            if start + 1e-6 < ct < end and nm != bar[-1]:
                bar.append(nm)
        measures.append({'index': n + 1, 'start': round(start, 2), 'chords': bar})
    return measures


def describe(key, bpm, chords):
    progression = ' → '.join(c['chord'] for c in chords[:6])
    ellipsis = '...' if len(chords) > 6 else ''
    return (
        f'This track sits in {key}, moving at roughly {bpm} BPM. '
        f'The progression opens with {progression}{ellipsis}, '
        f'built from {len(chords)} chord changes across the song.'
    )


COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')


def _log(msg):
    # Goes to stderr, which the systemd unit routes to a regular file (not
    # journald), so these never block. Used to time each stage and see where
    # a slow request actually spends its time.
    print(f'[timing] {msg}', file=sys.stderr, flush=True)


def _pp_hook(d):
    pp = d.get('postprocessor', '?')
    if d.get('status') == 'started':
        _log(f'ffmpeg postprocessor {pp} started')
    elif d.get('status') == 'finished':
        _log(f'ffmpeg postprocessor {pp} finished')


def download_audio(url, workdir, video_id, progress=None):
    # Translate yt-dlp's frequent download callbacks into throttled progress
    # events (only when the percentage actually advances) so the frontend gets
    # a real, smooth download bar without flooding the stream.
    state = {'pct': -10}

    def dl_hook(d):
        status = d.get('status')
        if status == 'downloading' and progress:
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            if total:
                pct = int(d.get('downloaded_bytes', 0) * 100 / total)
                if pct >= state['pct'] + 5:
                    state['pct'] = pct
                    progress({'stage': 'download', 'pct': max(0, min(100, pct))})
        elif status == 'finished':
            _log('yt-dlp download finished; starting ffmpeg postprocessing')
            if progress:
                progress({'stage': 'convert'})

    ydl_opts = {
        # A low-bitrate audio stream is acoustically identical for chord/key/
        # BPM detection (which runs on 22 kHz mono) but a fraction of the bytes
        # to download. It's also plenty for the in-page play-along audio.
        # Fall back to bestaudio/best when no small format exists.
        'format': 'bestaudio[abr<=80]/bestaudio/best',
        'outtmpl': os.path.join(workdir, '%(id)s.%(ext)s'),
        # Extract to MP3 — universally playable in browsers (incl. iOS Safari),
        # so the same file we analyze is the one we serve back for in-page
        # playback. That lets the frontend drop the YouTube embed entirely,
        # which is what triggers YouTube's "confirm you're not a bot" prompts.
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '128',
        }],
        # EBU R128 loudness normalization so every analyzed track plays back at a
        # consistent volume — no lunging for the volume knob between songs.
        'postprocessor_args': {'extractaudio': ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11']},
        'quiet': True,
        'no_warnings': True,
        # quiet=True silences info messages but NOT the download progress
        # bar, which streams rapid \r updates to stderr. Under systemd,
        # gunicorn's stderr is a pipe to journald (rate-limited); that
        # firehose of progress writes fills the pipe and write() blocks,
        # freezing yt-dlp's download loop until gunicorn's 120s timeout
        # kills the worker. Run under the bare Flask dev server (stderr to
        # a file/tty, which never blocks) and the exact same download flies.
        # Suppressing progress output removes the blocking writes entirely.
        'noprogress': True,
        # YouTube's player JS challenge (signature/n-param) needs a JS
        # runtime to solve. --js-runtimes is a CLI-only setting that the
        # yt_dlp.YoutubeDL library API never reads from
        # ~/.config/yt-dlp/config, so it must be set here directly.
        'js_runtimes': {'node': {}},
        # Without a read timeout, a stalled googlevideo connection blocks
        # forever instead of triggering yt-dlp's own retry logic, so the
        # whole gunicorn worker eventually gets killed by --timeout instead
        # of recovering. A short socket_timeout + retries lets yt-dlp detect
        # a stall and reconnect well within gunicorn's 120s budget.
        'socket_timeout': 20,
        'retries': 10,
        'fragment_retries': 10,
        # Rules out IPv6 routing being the thing that stalls under WSL2/
        # Hyper-V, independent of whether that's actually the cause.
        'force_ipv4': True,
        # YouTube throttles a googlevideo URL to a crawl (a few KB/s) when
        # it decides to rate-limit this IP — the download trickles bytes
        # just fast enough to dodge socket_timeout but slow enough that a
        # 3-4 MB file blows past gunicorn's 120s worker timeout. This tells
        # yt-dlp: if throughput drops below 100 KB/s, abandon the throttled
        # URL and re-extract a fresh, un-throttled one instead of crawling.
        'throttledratelimit': 102400,
        # NOTE: tried pinning the `ios` player client to skip the JS challenge,
        # but it frequently failed and fell back to `web` anyway — paying for
        # both paths and pushing the download to ~30s. The default client order
        # is faster and more reliable, so we leave it alone. The real win came
        # from analyzing at 11 kHz (see run_analysis), not from the download.
        # If the audio is delivered as fragments, fetch a few in parallel.
        'concurrent_fragment_downloads': 4,
        'progress_hooks': [dl_hook],
        'postprocessor_hooks': [_pp_hook],
    }
    if os.path.exists(COOKIES_FILE):
        ydl_opts['cookiefile'] = COOKIES_FILE
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    # Move the MP3 into the cache under the URL's video id (what the frontend
    # will request from /audio/<id>) so it persists for playback after the
    # temp workdir is cleaned up. librosa reads this same file for analysis.
    produced = os.path.join(workdir, f"{info['id']}.mp3")
    audio_path = os.path.join(CACHE_DIR, f'{video_id}.mp3')
    shutil.move(produced, audio_path)
    return audio_path, info.get('title', 'Unknown Song'), int(info.get('duration', 0))


@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


@app.route('/audio/<video_id>', methods=['GET'])
def serve_audio(video_id):
    # Serves the downloaded MP3 for in-page playback. conditional=True enables
    # HTTP range requests so the <audio> element can seek. The id is validated
    # to a YouTube-id charset so it can't escape the cache directory.
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,20}', video_id):
        abort(404)
    path = os.path.join(CACHE_DIR, f'{video_id}.mp3')
    if not os.path.isfile(path):
        abort(404)
    # Bump mtime so prune_cache()'s LRU keeps songs people actually replay,
    # not just the most recently analyzed ones.
    try:
        os.utime(path, None)
    except OSError:
        pass
    resp = send_file(path, mimetype='audio/mpeg', conditional=True)
    # A given video's audio never changes, so let Cloudflare (and the browser)
    # cache it hard — repeat plays of a popular song are then served from the
    # edge instead of tying up a gunicorn worker streaming the file every time.
    resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    return resp


def run_analysis(url, video_id, progress=None):
    def emit(ev):
        if progress:
            progress(ev)

    workdir = tempfile.mkdtemp(prefix='song-analyzer-')
    try:
        t0 = time.monotonic()
        emit({'stage': 'download', 'pct': 0})
        audio_path, title, duration = download_audio(url, workdir, video_id, progress=progress)
        t1 = time.monotonic()
        _log(f'download_audio (yt-dlp download + ffmpeg->mp3): {t1 - t0:.1f}s')
        emit({'stage': 'load'})
        # 11 kHz mono is plenty for chord/beat analysis — the constant-Q chroma
        # covers the same note range (C1–C8 sits well under the 5.5 kHz Nyquist),
        # so chords are unchanged — but it's roughly half the samples to load and
        # transform, shaving a few seconds off the analysis.
        y, sr = librosa.load(audio_path, sr=11025, mono=True)
        t2 = time.monotonic()
        _log(f'librosa.load: {t2 - t1:.1f}s')

        emit({'stage': 'analyze'})
        # beat_track gives us both tempo and the beat grid; we keep the grid so
        # chord detection can be beat-synchronous instead of fixed-window.
        tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=512)
        bpm = int(round(float(np.asarray(tempo).item())))

        # chroma_cqt is the most expensive step here, so compute it once and
        # reuse it for both key detection and chord detection instead of
        # running it twice.
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512)
        key = detect_key(chroma.mean(axis=1))
        chords = detect_chords(chroma, sr, beat_frames=beat_frames, hop_length=512)
        try:
            measures = build_measures(beat_frames, chords, sr, hop_length=512)
        except Exception as exc:  # measures are a bonus, never break analysis
            _log(f'build_measures failed: {exc}')
            measures = []
        _log(f'analysis (beat+key+chords): {time.monotonic() - t2:.1f}s')

        return {
            'success': True,
            'title': title,
            'bpm': bpm,
            'key': key,
            'duration': duration,
            'chords': chords,
            'measures': measures,
            'description': describe(key, bpm, chords),
            'audio_url': f'/audio/{video_id}',
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _ndjson(obj):
    return json.dumps(obj) + '\n'


def produce_result(url, video_id, progress=None):
    # Cache + per-video lock + concurrency slot wrapped around the analysis.
    # Returns the result dict (cached or freshly computed). `progress`, if given,
    # receives stage events for live streaming. Shared by both response modes so
    # streaming and plain-JSON callers go through identical logic.
    cache_path = os.path.join(CACHE_DIR, f'{video_id}.json')
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return json.load(f)

    # Per-video lock: concurrent requests for the SAME song serialize and share
    # one result instead of each re-downloading. Works across worker processes.
    lock_path = os.path.join(CACHE_DIR, f'{video_id}.lock')
    with open(lock_path, 'w') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            if os.path.exists(cache_path):
                with open(cache_path) as f:
                    return json.load(f)
            # Concurrency slot keeps overlapping analyses from thrashing the box.
            with analysis_slot():
                result = run_analysis(url, video_id, progress=progress)
            with open(cache_path, 'w') as f:
                json.dump(result, f)
            prune_cache()
            return result
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


@app.route('/', methods=['POST', 'OPTIONS'])
def analyze():
    if request.method == 'OPTIONS':
        return '', 204

    url = (request.get_json(silent=True) or {}).get('url')
    if not url:
        return jsonify(success=False, error='YouTube URL required'), 400
    video_id = extract_video_id(url)
    if not video_id:
        return jsonify(success=False, error='Invalid YouTube URL'), 400

    # Content negotiation: stream newline-delimited progress JSON only when the
    # client asks for it (Accept: application/x-ndjson). Everyone else gets the
    # classic single JSON object — so old and new frontends both work against
    # this backend, and there's no broken window during a rolling deploy.
    wants_stream = 'application/x-ndjson' in (request.headers.get('Accept') or '')

    if not wants_stream:
        try:
            result = produce_result(url, video_id)
        except Exception as exc:
            app.logger.exception('Analysis failed')
            return jsonify(success=False, error=str(exc)), 500
        return jsonify(result)

    # Streaming mode: the heavy work runs in a worker thread that pushes events
    # through a queue; the request thread relays them as newline-delimited JSON,
    # ending with a final {"stage": "done", ...full result...}. The done line
    # always carries the complete result, so a client/proxy that buffers the
    # stream still gets a correct answer.
    def generate():
        events = queue.Queue()

        def worker():
            try:
                result = produce_result(
                    url, video_id,
                    progress=lambda ev: events.put(('progress', ev)))
                events.put(('done', result))
            except Exception as exc:
                app.logger.exception('Analysis failed')
                events.put(('error', str(exc)))

        threading.Thread(target=worker, daemon=True).start()

        deadline = time.monotonic() + STREAM_DEADLINE
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                # Throttled/stuck download running long. Return a clear message
                # instead of letting the worker hit gunicorn's hard timeout and
                # drop the connection. The background thread keeps going and
                # caches its result, so the next try is instant.
                yield _ndjson({'stage': 'error', 'success': False,
                               'error': "YouTube is rate-limiting this server's "
                                        "downloads right now. It'll finish in the "
                                        "background — try again in a minute."})
                return
            try:
                kind, payload = events.get(timeout=min(remaining, 5))
            except queue.Empty:
                continue
            if kind == 'progress':
                yield _ndjson(payload)
            elif kind == 'done':
                yield _ndjson({'stage': 'done', **payload})
                return
            else:  # error
                yield _ndjson({'stage': 'error', 'success': False,
                               'error': payload})
                return

    resp = app.response_class(stream_with_context(generate()),
                              mimetype='application/x-ndjson')
    # Discourage proxy/CDN buffering so progress events arrive as they happen.
    resp.headers['Cache-Control'] = 'no-cache'
    resp.headers['X-Accel-Buffering'] = 'no'
    return resp


def _prewarm():
    # librosa's beat_track and chroma_cqt run through numba, which JIT-compiles
    # on first use — so the very first real analysis after a (re)start eats a
    # one-time multi-second compile cost. Exercise those paths once at import
    # on a tiny synthetic tone so each gunicorn worker pays that cost at boot
    # instead of on a user's first request.
    try:
        t = np.arange(22050, dtype=np.float32) / 22050
        y = (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        librosa.beat.beat_track(y=y, sr=22050)
        librosa.feature.chroma_cqt(y=y, sr=22050, hop_length=512)
        _log('numba prewarm complete')
    except Exception as exc:  # never let prewarm failure stop the worker
        _log(f'numba prewarm skipped: {exc}')


_prewarm()


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 5005)))
