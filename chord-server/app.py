"""
Local chord-detection backend for the Song Analyzer tool.

Downloads a YouTube video's audio, then uses librosa to detect tempo (BPM),
key, and a chord progression with timestamps. Replaces the mock data
currently served by worker/song-analyzer-worker.js.

Run with: python app.py
"""
import fcntl
import json
import os
import re
import shutil
import tempfile

import librosa
import numpy as np
import yt_dlp
from flask import Flask, jsonify, request

app = Flask(__name__)

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
os.makedirs(CACHE_DIR, exist_ok=True)

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


def detect_chords(y, sr, segment_seconds=2.0):
    hop_length = 512
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
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


def download_audio(url, workdir):
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(workdir, '%(id)s.%(ext)s'),
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'wav',
            'preferredquality': '192',
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
    }
    if os.path.exists(COOKIES_FILE):
        ydl_opts['cookiefile'] = COOKIES_FILE
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    audio_path = os.path.join(workdir, f"{info['id']}.wav")
    return audio_path, info.get('title', 'Unknown Song'), int(info.get('duration', 0))


@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response


def run_analysis(url):
    workdir = tempfile.mkdtemp(prefix='song-analyzer-')
    try:
        audio_path, title, duration = download_audio(url, workdir)
        y, sr = librosa.load(audio_path, sr=22050, mono=True)

        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = int(round(float(np.asarray(tempo).item())))

        key = detect_key(librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1))
        chords = detect_chords(y, sr)

        return {
            'success': True,
            'title': title,
            'bpm': bpm,
            'key': key,
            'duration': duration,
            'chords': chords,
            'description': describe(key, bpm, chords),
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
                result = run_analysis(url)
            except Exception as exc:
                app.logger.exception('Analysis failed')
                return jsonify(success=False, error=str(exc)), 500

            with open(cache_path, 'w') as f:
                json.dump(result, f)
            return jsonify(result)
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 5005)))
