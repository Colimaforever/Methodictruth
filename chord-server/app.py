"""
Local chord-detection backend for the Song Analyzer tool.

Downloads a YouTube video's audio, then uses librosa to detect tempo (BPM),
key, and a chord progression with timestamps. Replaces the mock data
currently served by worker/song-analyzer-worker.js.

Run with: python app.py
"""
import os
import re
import shutil
import tempfile

import librosa
import numpy as np
import yt_dlp
from flask import Flask, jsonify, request

app = Flask(__name__)

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
    }
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


@app.route('/', methods=['POST', 'OPTIONS'])
def analyze():
    if request.method == 'OPTIONS':
        return '', 204

    url = (request.get_json(silent=True) or {}).get('url')
    if not url:
        return jsonify(success=False, error='YouTube URL required'), 400
    if not extract_video_id(url):
        return jsonify(success=False, error='Invalid YouTube URL'), 400

    workdir = tempfile.mkdtemp(prefix='song-analyzer-')
    try:
        audio_path, title, duration = download_audio(url, workdir)
        y, sr = librosa.load(audio_path, sr=22050, mono=True)

        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = int(round(float(tempo)))

        key = detect_key(librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1))
        chords = detect_chords(y, sr)

        return jsonify(
            success=True,
            title=title,
            bpm=bpm,
            key=key,
            duration=duration,
            chords=chords,
            description=describe(key, bpm, chords),
        )
    except Exception as exc:
        app.logger.exception('Analysis failed')
        return jsonify(success=False, error=str(exc)), 500
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.environ.get('PORT', 5005)))
