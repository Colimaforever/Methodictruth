"""
Local chord-detection backend for the Song Analyzer tool.

Downloads a YouTube video's audio, then uses librosa to detect tempo (BPM),
key, and a chord progression with timestamps. Replaces the mock data
currently served by worker/song-analyzer-worker.js.

Run with: python app.py
"""
import faulthandler
import fcntl
import hashlib
import json
import os
import queue
import re
import shutil
import signal
import subprocess
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

# ── YouTube download budget ──
# YouTube throttles per-IP based on request *pattern* more than volume: a burst
# of back-to-back downloads trips its bot detector and burns the IP for hours,
# while the same downloads spaced out sail through. So we deliberately pace:
# at least YT_MIN_GAP seconds between download starts (bursts queue), and at
# most YT_HOURLY_CAP fresh downloads per rolling hour (beyond that, callers get
# an honest "paused to stay under the radar" message instead of a doomed
# attempt that would deepen the throttle). Uploads and cached songs are
# unaffected — this gates only actual YouTube traffic.
YT_MIN_GAP = max(0, int(os.environ.get('YT_MIN_GAP', '20')))
YT_HOURLY_CAP = max(1, int(os.environ.get('YT_HOURLY_CAP', '12')))

# ── Egress proxy for YouTube fetches only ──
# YouTube weighs the *reputation of the IP* heavily: a home/residential address
# sails through where a datacenter address gets "Sign in to confirm you're not
# a bot". That makes a cloud VM strictly worse at this than a home box unless
# the YouTube hop is routed through a residential/ISP proxy. Set YT_PROXY to
# such an endpoint (http://user:pass@host:port) and ONLY the yt-dlp request
# uses it — uploads, analysis, and audio serving stay direct, so a proxy
# outage can never take the whole service down. Empty = direct connection
# (correct for a home/residential host).
YT_PROXY = os.environ.get('YT_PROXY', '').strip()

# Randomized pause before each fetch. Perfectly regular request timing is
# itself a bot signal; a little jitter costs nothing and looks human.
# At this tool's volume (a dozen downloads an hour at most, already spaced
# by YT_MIN_GAP) a long pause buys nothing and every second of it is a second
# the visitor watches a spinner, so the default is short.
YT_SLEEP_MIN = max(0, int(os.environ.get('YT_SLEEP_MIN', '0')))
YT_SLEEP_MAX = max(YT_SLEEP_MIN, int(os.environ.get('YT_SLEEP_MAX', '2')))

# Direct file uploads (the no-YouTube path). 30 MB covers a ~30-minute MP3.
app.config['MAX_CONTENT_LENGTH'] = 30 * 1024 * 1024


class BudgetExceeded(Exception):
    """Raised when the rolling-hour YouTube download budget is spent."""


def _yt_recent_downloads():
    # Timestamps (epoch seconds) of downloads in the last hour, from the shared
    # log file. Tolerates a missing/corrupt file.
    path = os.path.join(CACHE_DIR, '.yt-downloads.log')
    cutoff = time.time() - 3600
    try:
        with open(path) as f:
            return [t for line in f if (t := float(line.strip() or 0)) > cutoff]
    except (OSError, ValueError):
        return []


def yt_download_gate(progress=None):
    # Cross-process pacing gate, entered right before a YouTube download.
    # 1) Budget check: if the rolling hour is spent, fail fast with a friendly
    #    message rather than making a throttle-deepening attempt.
    # 2) Spacing: under a lock, wait until YT_MIN_GAP has passed since the last
    #    download started, then stamp our start time. Concurrent requests queue
    #    on the flock, so bursts become an evenly spaced trickle.
    recent = _yt_recent_downloads()
    if len(recent) >= YT_HOURLY_CAP:
        wait_min = max(1, int((min(recent) + 3600 - time.time()) / 60))
        raise BudgetExceeded(
            f'Taking a short break from YouTube downloads to stay under its '
            f'rate limits ({YT_HOURLY_CAP} fresh songs/hour). Try again in '
            f'~{wait_min} min — or pick a song from the Library, those play '
            f'instantly.')

    gate_path = os.path.join(CACHE_DIR, '.yt-gate.lock')
    stamp_path = os.path.join(CACHE_DIR, '.yt-last-download')
    with open(gate_path, 'w') as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        try:
            try:
                last = float(open(stamp_path).read().strip() or 0)
            except (OSError, ValueError):
                last = 0.0
            wait = last + YT_MIN_GAP - time.time()
            if wait > 0:
                if progress:
                    progress({'stage': 'paced'})
                time.sleep(wait)
            now = time.time()
            with open(stamp_path, 'w') as f:
                f.write(str(now))
            # Record into the rolling budget log, pruning old entries.
            keep = [t for t in _yt_recent_downloads()] + [now]
            with open(os.path.join(CACHE_DIR, '.yt-downloads.log'), 'w') as f:
                f.write('\n'.join(str(t) for t in keep) + '\n')
        finally:
            fcntl.flock(gate, fcntl.LOCK_UN)


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

# Every shape a YouTube link arrives in: watch?v=, youtu.be short links,
# /embed/, /shorts/, /live/, /v/, music.youtube.com and m.youtube.com (the
# host prefix is not anchored, so those match too), plus a bare 11-character
# video id pasted on its own.
YOUTUBE_RE = re.compile(
    r'(?:youtube\.com/(?:watch\?(?:.*&)?v=|embed/|shorts/|live/|v/)|youtu\.be/)([A-Za-z0-9_-]{11})')
BARE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{11}$')


def extract_video_id(url):
    url = (url or '').strip()
    match = YOUTUBE_RE.search(url)
    if match:
        return match.group(1)
    return url if BARE_ID_RE.match(url) else None


def detect_key_detailed(chroma_mean):
    # Krumhansl-style profile matching, but keep the whole scoreboard so we can
    # report HOW decisive the winner was (gap to the runner-up, mapped to a
    # 0-1 confidence) and what the plausible alternative reading is.
    scores = []
    for i in range(12):
        scores.append((float(np.corrcoef(chroma_mean, np.roll(MAJOR_PROFILE, i))[0, 1]), f'{NOTES[i]} Major'))
        scores.append((float(np.corrcoef(chroma_mean, np.roll(MINOR_PROFILE, i))[0, 1]), f'{NOTES[i]} Minor'))
    scores.sort(reverse=True)
    best_score, best_key = scores[0]
    second_score, second_key = scores[1]
    # A 0.15 correlation gap over 23 competitors is decisively unambiguous;
    # scale linearly below that. Floor at 0.05 so it never reads as zero.
    confidence = round(min(1.0, max(0.05, (best_score - second_score) / 0.15)), 2)
    return {'key': best_key, 'confidence': confidence, 'alternative': second_key}


def detect_key(chroma_mean):
    return detect_key_detailed(chroma_mean)['key']


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


def estimate_meter(onset_env, beat_frames):
    # Cheap accent-pattern test: sum onset strength at every beat, then compare
    # how well the accents repeat with period 4 vs period 3. Pop/rock lands on
    # 4 almost always; a clear 3 is usually a waltz/6-8 feel. This is a
    # heuristic — treat it as an informed guess, not gospel.
    beats = np.asarray(beat_frames)
    if len(beats) < 12:
        return {'beats_per_bar': 4, 'confidence': 'low'}
    strengths = onset_env[np.clip(beats, 0, len(onset_env) - 1)]
    def periodicity(p):
        groups = [strengths[i::p] for i in range(p)]
        means = np.array([g.mean() for g in groups if len(g)])
        return float(means.max() - means.mean()) if len(means) else 0.0
    s4, s3 = periodicity(4), periodicity(3)
    if s3 > s4 * 1.25:
        return {'beats_per_bar': 3, 'confidence': 'medium'}
    return {'beats_per_bar': 4, 'confidence': 'high' if s4 > s3 * 1.25 else 'medium'}


def detect_sections(chroma, rms, sr, duration, hop_length=512):
    # Structural segmentation: agglomeratively cluster the chroma sequence into
    # k contiguous segments (k scales with song length), then give segments
    # that sound alike the SAME letter — so a returning chorus reads as the
    # same "B" both times. Energy decides which letter gets called loudest.
    n_frames = chroma.shape[1]
    k = int(np.clip(round(duration / 35.0), 3, 9))
    if n_frames < k * 8:
        return []
    bounds = librosa.segment.agglomerative(chroma, k)
    bounds = np.concatenate([[0], bounds, [n_frames]]) if bounds[0] != 0 else np.concatenate([bounds, [n_frames]])
    bounds = np.unique(bounds)
    times = librosa.frames_to_time(bounds, sr=sr, hop_length=hop_length)

    # Fingerprint each segment by its mean chroma; same-letter segments are
    # those whose fingerprints correlate strongly with an earlier one.
    fingerprints, letters, sections = [], [], []
    for i in range(len(bounds) - 1):
        seg = chroma[:, bounds[i]:bounds[i + 1]]
        seg_rms = rms[bounds[i]:min(bounds[i + 1], len(rms))]
        fp = seg.mean(axis=1)
        letter = None
        for j, prev in enumerate(fingerprints):
            if np.corrcoef(fp, prev)[0, 1] > 0.90:
                letter = letters[j]
                break
        if letter is None:
            letter = chr(ord('A') + len(set(letters)))
        fingerprints.append(fp)
        letters.append(letter)
        sections.append({
            'start': round(float(times[i]), 1),
            'end': round(float(times[i + 1]), 1),
            'label': letter,
            'energy': round(float(seg_rms.mean()) if len(seg_rms) else 0.0, 4),
        })
    # Normalize section energy 0-1 so the frontend can draw relative intensity.
    peak = max((s['energy'] for s in sections), default=0) or 1
    for s in sections:
        s['energy'] = round(s['energy'] / peak, 2)
    return sections


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


def describe(core):
    # Turn the analysis dict into a musician-readable paragraph. Every claim
    # here comes from a measured value — no filler.
    key, bpm, chords = core['key'], core['bpm'], core['chords']
    parts = []

    feel = ('a slow' if bpm < 76 else 'a laid-back' if bpm < 100 else
            'a mid-tempo' if bpm < 120 else 'an upbeat' if bpm < 150 else 'a driving')
    conf = core.get('key_confidence')
    key_phrase = f'sits in {key}'
    if conf is not None and conf < 0.35 and core.get('key_alternative'):
        key_phrase += f" (though {core['key_alternative']} is a close second reading)"
    meter = core.get('meter') or {}
    meter_phrase = ' in a waltz-like 3 feel' if meter.get('beats_per_bar') == 3 else ''
    tempo_phrase = f"moves at {feel} {core.get('bpm_precise', bpm)} BPM{meter_phrase}"
    if core.get('bpm_alternative'):
        tempo_phrase += f" (or {core['bpm_alternative']} if you feel it in half/double time)"
    parts.append(f'This track {key_phrase} and {tempo_phrase}.')

    progression = ' → '.join(c['chord'] for c in chords[:6])
    if progression:
        ellipsis = '…' if len(chords) > 6 else ''
        parts.append(f'The progression opens {progression}{ellipsis}, '
                     f'with {len(chords)} chord changes across the song.')

    sections = core.get('sections') or []
    if sections:
        distinct = len({s['label'] for s in sections})
        loudest = max(sections, key=lambda s: s.get('energy', 0))
        m, s = divmod(int(loudest['start']), 60)
        parts.append(f'Structurally it breaks into {len(sections)} sections '
                     f'({distinct} distinct parts), peaking in intensity around {m}:{s:02d}.')

    loud = core.get('loudness') or {}
    dr = loud.get('dynamic_range_db')
    if dr is not None:
        dyn = ('tightly compressed' if dr < 6 else 'moderately dynamic' if dr < 12 else 'very dynamic')
        parts.append(f"The mix is {core.get('brightness', 'balanced')} in tone and {dyn} "
                     f'({dr} dB of loudness range).')

    return ' '.join(parts)


COOKIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cookies.txt')


def _log(msg):
    # Goes to stderr, which the systemd unit routes to a regular file (not
    # journald), so these never block. Used to time each stage and see where
    # a slow request actually spends its time. Stamped with wall-clock time
    # and the worker pid so gaps between lines are readable and interleaved
    # workers can be told apart.
    print(f'[timing] {time.strftime("%Y-%m-%d %H:%M:%S")} pid={os.getpid()} {msg}', file=sys.stderr, flush=True)


def _pp_hook(d):
    pp = d.get('postprocessor', '?')
    if d.get('status') == 'started':
        _log(f'ffmpeg postprocessor {pp} started')
    elif d.get('status') == 'finished':
        _log(f'ffmpeg postprocessor {pp} finished')


# The bot check is per-client as much as per-IP: when the default web client
# gets "Sign in to confirm you're not a bot", another of YouTube's own
# players is often still served. So a bot-check failure is retried once
# through these before giving up. They are the three clients yt-dlp's PO
# Token guide lists as NOT needing a proof-of-origin token for their streams
# (web, mweb and ios do, and get throttled or 403'd without one), so the
# retry never trades a bot check for a throttle. Client names yt-dlp doesn't
# know are skipped with a warning, not an error.
YT_FALLBACK_CLIENTS = ['tv', 'web_embedded', 'android_vr']


def _is_bot_check(msg):
    m = msg.lower()
    return 'sign in to confirm' in m or 'not a bot' in m or 'cookies' in m


def _yt_download_with_fallback(url, ydl_opts):
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            return ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        if not _is_bot_check(str(exc)):
            raise
        _log(f'bot check on default client; retrying via {YT_FALLBACK_CLIENTS}')
        retry_opts = dict(ydl_opts)
        retry_opts['extractor_args'] = {'youtube': {'player_client': YT_FALLBACK_CLIENTS}}
        with yt_dlp.YoutubeDL(retry_opts) as ydl:
            return ydl.extract_info(url, download=True)


# ── YouTube status, for /health ──
# The question the owner actually has is "is YouTube working right now?", and
# the only honest answer comes from real downloads. Every attempt writes its
# outcome to a small file in the cache dir (shared across gunicorn workers),
# and /health reports the last success and the last failure. A probe on demand
# (/health?probe=1) asks YouTube for metadata without downloading anything.
YT_STATUS_FILE = os.path.join(CACHE_DIR, '.yt-status.json')
YT_PROBE_VIDEO = 'jNQXAC9IVRw'   # "Me at the zoo": the first YouTube video, never going away
YT_PROBE_TTL = 600               # seconds a probe result is reused


def _yt_status_read():
    try:
        with open(YT_STATUS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _yt_status_record(ok, error=None):
    st = _yt_status_read()
    now = time.time()
    if ok:
        st['last_ok'] = now
        st['consecutive_failures'] = 0
    else:
        st['last_error_at'] = now
        st['last_error'] = error or 'unknown'
        st['consecutive_failures'] = int(st.get('consecutive_failures', 0)) + 1
    try:
        tmp = YT_STATUS_FILE + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(st, f)
        os.replace(tmp, YT_STATUS_FILE)
    except OSError:
        pass


def _yt_probe():
    # Metadata-only: proves the extractor still understands YouTube's player
    # (the thing that breaks when YouTube changes something) without spending
    # a download on it. Cached so a health poller can't turn into a bot signal.
    st = _yt_status_read()
    probe = st.get('probe') or {}
    if probe and time.time() - probe.get('at', 0) < YT_PROBE_TTL:
        return probe
    opts = {'quiet': True, 'no_warnings': True, 'skip_download': True,
            'noprogress': True, 'socket_timeout': 15,
            'js_runtimes': {'deno': {}, 'node': {}}}
    if YT_PROXY:
        opts['proxy'] = YT_PROXY
    if os.path.exists(COOKIES_FILE):
        opts['cookiefile'] = COOKIES_FILE
    t0 = time.monotonic()
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f'https://www.youtube.com/watch?v={YT_PROBE_VIDEO}', download=False)
        has_audio = any(f.get('acodec') not in (None, 'none') for f in (info.get('formats') or []))
        probe = {'ok': bool(has_audio), 'at': time.time(), 'seconds': round(time.monotonic() - t0, 1),
                 'error': None if has_audio else 'no audio formats offered'}
    except Exception as exc:  # noqa: BLE001 — anything here is a "YouTube is broken" answer
        probe = {'ok': False, 'at': time.time(), 'seconds': round(time.monotonic() - t0, 1),
                 'error': str(exc)[:300]}
    st['probe'] = probe
    try:
        tmp = YT_STATUS_FILE + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(st, f)
        os.replace(tmp, YT_STATUS_FILE)
    except OSError:
        pass
    return probe


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
        # Deno is the runtime yt-dlp supports and tests against; Node is
        # accepted but second-class, and a YouTube change that the Node path
        # can't solve shows up as throttled or failed downloads. Listing both
        # means the box uses Deno when it has it and still works when it
        # doesn't. See README: "Install Deno".
        'js_runtimes': {'deno': {}, 'node': {}},
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
        # Jittered pause before the request — regular timing is a bot signal.
        'sleep_interval': YT_SLEEP_MIN,
        'max_sleep_interval': YT_SLEEP_MAX,
    }
    # Route ONLY this request through the residential/ISP proxy when configured.
    # Everything else (uploads, analysis, serving audio) stays direct.
    if YT_PROXY:
        ydl_opts['proxy'] = YT_PROXY
    if os.path.exists(COOKIES_FILE):
        ydl_opts['cookiefile'] = COOKIES_FILE
    # Pace + budget-check the actual YouTube hit (raises BudgetExceeded when
    # the hourly budget is spent; sleeps to space out bursts otherwise).
    yt_download_gate(progress)
    # Before any byte arrives, yt-dlp has to fetch the watch page, solve the
    # player challenge and pick a stream — several seconds that used to sit
    # under "Downloading audio" at 5% and look like a stall.
    if progress:
        progress({'stage': 'extract'})
    try:
        info = _yt_download_with_fallback(url, ydl_opts)
        _yt_status_record(ok=True)
    except yt_dlp.utils.DownloadError as exc:
        # Translate yt-dlp's raw failure text into something a visitor can act
        # on. The upload path is always the reliable escape hatch, so point at
        # it whenever YouTube itself is the obstacle.
        msg = str(exc)
        _yt_status_record(ok=False, error=msg[:300])
        if 'Sign in to confirm' in msg or 'bot' in msg.lower():
            raise RuntimeError(
                "YouTube is asking this server for a human check on that video. "
                "Easiest fix: download/export the audio yourself and drop the file "
                "into the analyzer — the file path never touches YouTube.") from exc
        if 'age' in msg.lower() and 'restrict' in msg.lower():
            raise RuntimeError(
                'That video is age-restricted, which blocks server-side downloads. '
                'Drop the audio file into the analyzer instead.') from exc
        if 'Private video' in msg or 'unavailable' in msg.lower() or 'removed' in msg.lower():
            raise RuntimeError('That video is private, removed, or unavailable in this region.') from exc
        if 'HTTP Error 429' in msg or 'rate' in msg.lower():
            raise RuntimeError(
                'YouTube is rate-limiting this server right now. Try again in a few '
                'minutes, pick a song from the Library, or drop an audio file in directly.') from exc
        if 'is not a valid URL' in msg or 'Unsupported URL' in msg:
            raise RuntimeError('That link doesn\'t look like a YouTube video URL.') from exc
        raise RuntimeError(
            'The download failed — YouTube may have changed something. '
            'Dropping the audio file into the analyzer always works.') from exc

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


def analyze_file(audio_path, emit):
    # The source-agnostic analysis core: takes any audio file (YouTube-derived
    # or user-uploaded) and returns bpm/key/chords/measures/duration. Every way
    # into the analyzer funnels through here, so improvements land everywhere.
    t1 = time.monotonic()
    emit({'stage': 'load'})
    # 11 kHz mono is plenty for chord/beat analysis — the constant-Q chroma
    # covers the same note range (C1–C8 sits well under the 5.5 kHz Nyquist),
    # so chords are unchanged — but it's roughly half the samples to load and
    # transform, shaving a few seconds off the analysis.
    y, sr = librosa.load(audio_path, sr=11025, mono=True)
    t2 = time.monotonic()
    _log(f'librosa.load: {t2 - t1:.1f}s')

    emit({'stage': 'analyze'})
    hop = 512
    # Onset envelope feeds beat tracking AND the meter estimate; computing it
    # once keeps beat_track's internal result identical to before.
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop)
    bpm_precise = float(np.asarray(tempo).item())
    bpm = int(round(bpm_precise))
    # Beat trackers routinely lock onto the half- or double-time reading of
    # the same groove; surface the alternative inside the common 70-180 range
    # so a "140 BPM" result also says "or 70, if you feel it in half time".
    bpm_alternative = None
    for cand in (bpm_precise / 2, bpm_precise * 2):
        if 70 <= cand <= 180 and not 70 <= bpm_precise <= 180:
            bpm_alternative = int(round(cand))
    meter = estimate_meter(onset_env, beat_frames)

    # chroma_cqt is the most expensive step here, so compute it once and
    # reuse it for key detection, chord detection, AND section structure.
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    key_info = detect_key_detailed(chroma.mean(axis=1))
    chords = detect_chords(chroma, sr, beat_frames=beat_frames, hop_length=hop)
    try:
        measures = build_measures(beat_frames, chords, sr, hop_length=hop,
                                  beats_per_bar=meter['beats_per_bar'])
    except Exception as exc:  # measures are a bonus, never break analysis
        _log(f'build_measures failed: {exc}')
        measures = []

    # ── Energy, loudness, and tonal character ──
    duration = len(y) / sr
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    rms_db = 20 * np.log10(np.maximum(rms, 1e-6))
    # 64-point normalized energy curve — enough to draw the song's whole arc.
    pts = 64
    edges = np.linspace(0, len(rms), pts + 1, dtype=int)
    curve = np.array([rms[a:b].mean() if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])])
    peak = curve.max() or 1.0
    energy_curve = [round(float(v / peak), 3) for v in curve]
    loudness = {
        'mean_db': round(float(rms_db.mean()), 1),
        'peak_db': round(float(rms_db.max()), 1),
        # p95 - p10 of the RMS spread: how far the loud parts sit above the
        # quiet parts. Small = flat/compressed, large = breathing dynamics.
        'dynamic_range_db': round(float(np.percentile(rms_db, 95) - np.percentile(rms_db, 10)), 1),
    }
    centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop).mean())
    brightness = ('dark' if centroid < 1100 else 'balanced' if centroid < 2000 else 'bright')

    try:
        sections = detect_sections(chroma, rms, sr, duration, hop_length=hop)
    except Exception as exc:  # structure is a bonus, never break analysis
        _log(f'detect_sections failed: {exc}')
        sections = []
    _log(f'analysis (beat+key+chords+structure): {time.monotonic() - t2:.1f}s')

    return {
        'bpm': bpm,
        'bpm_precise': round(bpm_precise, 1),
        'bpm_alternative': bpm_alternative,
        'meter': meter,
        'key': key_info['key'],
        'key_confidence': key_info['confidence'],
        'key_alternative': key_info['alternative'],
        'duration': int(duration),
        'beat_count': int(len(beat_frames)),
        'chords': chords,
        'measures': measures,
        'sections': sections,
        'energy_curve': energy_curve,
        'loudness': loudness,
        'brightness': brightness,
        'spectral_centroid_hz': int(centroid),
    }


def run_analysis(url, video_id, progress=None):
    def emit(ev):
        if progress:
            progress(ev)

    workdir = tempfile.mkdtemp(prefix='song-analyzer-')
    try:
        t0 = time.monotonic()
        emit({'stage': 'download', 'pct': 0})
        audio_path, title, duration = download_audio(url, workdir, video_id, progress=progress)
        _log(f'download_audio (yt-dlp download + ffmpeg->mp3): {time.monotonic() - t0:.1f}s')
        core = analyze_file(audio_path, emit)
        core['duration'] = duration or core['duration']

        return {
            'success': True,
            'title': title,
            **core,
            'description': describe(core),
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


@app.route('/health', methods=['GET'])
def health():
    # A one-request answer to "is the box actually fine?" — used to verify a
    # migration landed and to monitor an unattended host. Deliberately reports
    # whether the egress proxy and cookies are configured (booleans only, never
    # the credentials themselves) since those are the two things that silently
    # degrade YouTube fetching on a datacenter IP.
    try:
        songs = len([f for f in os.listdir(CACHE_DIR) if f.endswith('.mp3')])
    except OSError:
        songs = -1
    st = _yt_status_read()
    now = time.time()
    probe = _yt_probe() if request.args.get('probe') else (st.get('probe') or None)
    # One word for the frontend to act on. "unknown" means no download has
    # been attempted since the status file was created — not a failure.
    if st.get('last_ok') and (not st.get('last_error_at') or st['last_ok'] >= st['last_error_at']):
        youtube = 'ok'
    elif int(st.get('consecutive_failures', 0)) >= 2:
        youtube = 'failing'
    elif st.get('last_error_at'):
        youtube = 'degraded'
    else:
        youtube = 'unknown'
    if probe and probe.get('at', 0) > max(st.get('last_ok', 0), st.get('last_error_at', 0)):
        youtube = 'ok' if probe.get('ok') else 'failing'
    try:
        import yt_dlp.version as _v
        ytdlp_version = _v.__version__
    except Exception:  # noqa: BLE001
        ytdlp_version = None
    # The PO-token provider is what stops YouTube throttling web-client
    # streams; report both halves of it — the yt-dlp plugin in the venv and
    # the local token server it talks to — so a throttled box is diagnosable
    # from one curl.
    try:
        import importlib.util
        pot_plugin = importlib.util.find_spec('yt_dlp_plugins.extractor.getpot_bgutil') is not None
    except Exception:  # noqa: BLE001
        pot_plugin = False
    try:
        import urllib.request
        with urllib.request.urlopen('http://127.0.0.1:4416/ping', timeout=1.5) as r:
            pot_server = r.status == 200
    except Exception:  # noqa: BLE001
        pot_server = False
    return jsonify(
        ok=True,
        cached_songs=songs,
        yt_proxy_configured=bool(YT_PROXY),
        cookies_present=os.path.exists(COOKIES_FILE),
        yt_downloads_last_hour=len(_yt_recent_downloads()),
        yt_hourly_cap=YT_HOURLY_CAP,
        analysis_slots=ANALYSIS_SLOTS,
        youtube=youtube,
        youtube_last_ok_ago=int(now - st['last_ok']) if st.get('last_ok') else None,
        youtube_last_error=st.get('last_error'),
        youtube_last_error_ago=int(now - st['last_error_at']) if st.get('last_error_at') else None,
        youtube_consecutive_failures=int(st.get('consecutive_failures', 0)),
        youtube_probe=probe,
        ytdlp_version=ytdlp_version,
        js_runtime_deno=bool(shutil.which('deno')),
        js_runtime_node=bool(shutil.which('node')),
        ffmpeg=bool(shutil.which('ffmpeg')),
        pot_plugin_installed=pot_plugin,
        pot_server_up=pot_server,
    )


@app.route('/library', methods=['GET'])
def library():
    # The cache, made visible: every already-analyzed song as a browsable list
    # so visitors replay at zero YouTube cost instead of triggering downloads.
    items = []
    try:
        for name in os.listdir(CACHE_DIR):
            if not name.endswith('.json'):
                continue
            vid = name[:-5]
            mp3 = os.path.join(CACHE_DIR, f'{vid}.mp3')
            if not os.path.isfile(mp3):
                continue  # play-along needs the audio
            try:
                with open(os.path.join(CACHE_DIR, name)) as f:
                    d = json.load(f)
                items.append({'id': vid, 'title': d.get('title', 'Unknown'),
                              'key': d.get('key'), 'bpm': d.get('bpm'),
                              'duration': d.get('duration'),
                              'mtime': os.path.getmtime(mp3)})
            except (OSError, ValueError):
                continue
    except OSError:
        pass
    items.sort(key=lambda x: x['mtime'], reverse=True)
    for it in items:
        del it['mtime']
    resp = jsonify(items[:60])
    resp.headers['Cache-Control'] = 'no-cache'
    return resp


@app.route('/result/<video_id>', methods=['GET'])
def cached_result(video_id):
    # Instant fetch of an already-analyzed song (Library clicks, shared links).
    # Never triggers a download — 404 means "not analyzed yet".
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,20}', video_id):
        abort(404)
    path = os.path.join(CACHE_DIR, f'{video_id}.json')
    if not os.path.isfile(path):
        abort(404)
    with open(path) as f:
        return jsonify(json.load(f))


def produce_upload_result(upload_id, src_path, title, emit):
    # Upload twin of produce_result: same cache/lock/slot discipline, no
    # YouTube anywhere. Transcodes to the cache MP3 (same loudness treatment
    # as the YouTube path), then runs the shared analysis core.
    cache_path = os.path.join(CACHE_DIR, f'{upload_id}.json')
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return json.load(f)

    lock_path = os.path.join(CACHE_DIR, f'{upload_id}.lock')
    with open(lock_path, 'w') as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        try:
            if os.path.exists(cache_path):
                with open(cache_path) as f:
                    return json.load(f)

            with analysis_slot():
                emit({'stage': 'convert'})
                mp3_path = os.path.join(CACHE_DIR, f'{upload_id}.mp3')
                proc = subprocess.run(
                    ['ffmpeg', '-y', '-i', src_path, '-vn', '-map_metadata', '-1',
                     '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-b:a', '128k', mp3_path],
                    capture_output=True, timeout=180)
                if proc.returncode != 0 or not os.path.isfile(mp3_path):
                    try:
                        os.remove(mp3_path)
                    except OSError:
                        pass
                    raise ValueError("Couldn't read that file as audio — try an "
                                     "MP3, M4A, WAV, OGG, or FLAC.")

                core = analyze_file(mp3_path, emit)
                result = {
                    'success': True,
                    'id': upload_id,
                    'title': title,
                    **core,
                    'description': describe(core),
                    'audio_url': f'/audio/{upload_id}',
                }
            with open(cache_path, 'w') as f:
                json.dump(result, f)
            prune_cache()
            return result
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)


@app.route('/upload', methods=['POST', 'OPTIONS'])
def upload():
    # The no-YouTube path: analyze a file the user already has. Content-hash id
    # means the same file re-uploaded (by anyone) is an instant cache hit.
    if request.method == 'OPTIONS':
        return '', 204
    f = request.files.get('file')
    if f is None or not f.filename:
        return jsonify(success=False, error='No audio file received'), 400

    data = f.read()
    if len(data) < 1024:
        return jsonify(success=False, error='That file looks empty'), 400
    upload_id = 'up-' + hashlib.sha1(data).hexdigest()[:12]
    title = re.sub(r'\.[A-Za-z0-9]{1,5}$', '', os.path.basename(f.filename))[:120] or 'Uploaded track'

    workdir = tempfile.mkdtemp(prefix='song-upload-')
    try:
        src = os.path.join(workdir, 'in' + os.path.splitext(f.filename)[1][:8])
        with open(src, 'wb') as out:
            out.write(data)
        result = produce_upload_result(upload_id, src, title, emit=lambda ev: None)
        return jsonify(result)
    except ValueError as exc:
        return jsonify(success=False, error=str(exc)), 400
    except Exception:
        app.logger.exception('Upload analysis failed')
        return jsonify(success=False, error='Analysis failed — try a different file.'), 500
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
        last_stage, last_pct = None, None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                # We ran past the streaming budget. The background thread keeps
                # going and caches its result, so a retry lands instantly either
                # way — but report WHY as precisely as we can. This used to
                # assert "YouTube is rate-limiting you" unconditionally, which
                # is an expensive thing to claim when the real cause is usually
                # a slow first run: it sends you debugging the wrong system.
                # We know which stage we stalled in, so say that instead.
                if last_stage in ('analyze', 'load'):
                    msg = ('Still analyzing — the first run after a restart is slower '
                           'while the audio engine warms up. It’s finishing in the '
                           'background; try again in a moment and it should be instant.')
                elif last_stage == 'download':
                    where = f' (stalled around {last_pct}%)' if last_pct is not None else ''
                    msg = (f'The audio download is crawling{where}, which usually means '
                           'YouTube is throttling this server. It’ll finish in the '
                           'background — or drop the audio file in directly, which '
                           'skips YouTube entirely.')
                elif last_stage == 'paced':
                    msg = ('Queued behind another download to stay under YouTube’s rate '
                           'limits. Try again shortly, or pick a song from the Library — '
                           'those play instantly.')
                else:
                    msg = ('This is taking longer than expected. It’s still running in '
                           'the background — try again in a minute, or drop an audio file '
                           'in to skip YouTube entirely.')
                yield _ndjson({'stage': 'error', 'success': False, 'error': msg,
                               'stalled_at': last_stage or 'start'})
                return
            try:
                kind, payload = events.get(timeout=min(remaining, 5))
            except queue.Empty:
                continue
            if kind == 'progress':
                # Remember where we got to, so a deadline hit can name the stage.
                if isinstance(payload, dict):
                    if payload.get('stage'):
                        last_stage = payload['stage']
                    if payload.get('pct') is not None:
                        last_pct = payload['pct']
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
