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
import re
import shutil
import signal
import sys
import tempfile
import time
from contextlib import contextmanager

import librosa
import numpy as np
import yt_dlp
from flask import Flask, abort, jsonify, request, send_file

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

# 12-bin binary chord templates: root + third + fifth, one per major/minor triad
CHORD_TEMPLATES = {}
for i, root in enumerate(NOTES):
    major = np.zeros(12)
    for interval in (0, 4, 7):
        major[(i + interval) % 12] = 1
    CHORD_TEMPLATES[root] = major

    minor = np.zeros(12)
    for interval in (0, 3, 7):
        minor[(i + interval) % 12] = 1
    CHORD_TEMPLATES[f'{root}m'] = minor

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


def detect_chords(chroma, sr, hop_length=512, segment_seconds=2.0):
    frames_per_segment = max(1, int(segment_seconds * sr / hop_length))

    chords, last_chord = [], None
    for start in range(0, chroma.shape[1], frames_per_segment):
        end = min(start + frames_per_segment, chroma.shape[1])
        segment = chroma[:, start:end].mean(axis=1)
        norm = np.linalg.norm(segment)
        if norm == 0:
            continue
        segment = segment / norm

        best_chord, best_score = None, -1
        for name, template in CHORD_TEMPLATES.items():
            score = float(np.dot(segment, template / np.linalg.norm(template)))
            if score > best_score:
                best_chord, best_score = name, score

        if best_chord != last_chord:
            timestamp = int(librosa.frames_to_time(start, sr=sr, hop_length=hop_length))
            chords.append({'chord': best_chord, 'timestamp': timestamp})
            last_chord = best_chord

    return chords


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


def _dl_hook(d):
    if d.get('status') == 'finished':
        _log('yt-dlp download finished; starting ffmpeg postprocessing')


def _pp_hook(d):
    pp = d.get('postprocessor', '?')
    if d.get('status') == 'started':
        _log(f'ffmpeg postprocessor {pp} started')
    elif d.get('status') == 'finished':
        _log(f'ffmpeg postprocessor {pp} finished')


def download_audio(url, workdir, video_id):
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
        'progress_hooks': [_dl_hook],
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
    return send_file(path, mimetype='audio/mpeg', conditional=True)


def run_analysis(url, video_id):
    workdir = tempfile.mkdtemp(prefix='song-analyzer-')
    try:
        t0 = time.monotonic()
        audio_path, title, duration = download_audio(url, workdir, video_id)
        t1 = time.monotonic()
        _log(f'download_audio (yt-dlp download + ffmpeg->mp3): {t1 - t0:.1f}s')
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        t2 = time.monotonic()
        _log(f'librosa.load: {t2 - t1:.1f}s')

        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = int(round(float(np.asarray(tempo).item())))

        # chroma_cqt is the most expensive step here, so compute it once and
        # reuse it for both key detection and chord detection instead of
        # running it twice.
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=512)
        key = detect_key(chroma.mean(axis=1))
        chords = detect_chords(chroma, sr)
        _log(f'analysis (beat+key+chords): {time.monotonic() - t2:.1f}s')

        return {
            'success': True,
            'title': title,
            'bpm': bpm,
            'key': key,
            'duration': duration,
            'chords': chords,
            'description': describe(key, bpm, chords),
            'audio_url': f'/audio/{video_id}',
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


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

    cache_path = os.path.join(CACHE_DIR, f'{video_id}.json')
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return jsonify(json.load(f))

    # File lock keyed by video ID: concurrent requests for the SAME song
    # serialize and share one result instead of each re-downloading and
    # re-analyzing; requests for different songs don't block each other.
    # Works across gunicorn worker processes, not just threads.
    lock_path = os.path.join(CACHE_DIR, f'{video_id}.lock')
    with open(lock_path, 'w') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            if os.path.exists(cache_path):
                with open(cache_path) as f:
                    return jsonify(json.load(f))

            try:
                # Limit total concurrent analyses so overlapping requests
                # (multiple users/devices) queue instead of thrashing the box.
                with analysis_slot():
                    result = run_analysis(url, video_id)
            except Exception as exc:
                app.logger.exception('Analysis failed')
                return jsonify(success=False, error=str(exc)), 500

            with open(cache_path, 'w') as f:
                json.dump(result, f)
            return jsonify(result)
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


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
