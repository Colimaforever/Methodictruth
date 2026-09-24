"""
GPU transcription sidecar for the Song Analyzer.

Runs as a SEPARATE process from app.py, in a SEPARATE virtualenv, for three
reasons that are all load-bearing:

  1. app.py runs under gunicorn with 4 workers. A Whisper model that got
     imported there would be loaded once per worker -- 4 x ~3 GB on a 6 GB
     card, which OOMs immediately. One process means exactly one copy.
  2. Serving requests from a single worker serializes GPU access for free.
     No semaphore, no lock file, no way for two transcriptions to collide
     over VRAM.
  3. torch/CUDA stays out of the live analyzer's dependency tree, so a bad
     torch upgrade can't take chord detection down with it.

The model is loaded at import (~30 s for large-v3) and stays resident, so
requests pay transcription time only.

Run with:
    ~/ml-venv/bin/gunicorn -w 1 --timeout 600 -b 127.0.0.1:5006 lyrics_service:app
"""
import os
import re
import time
from collections import Counter

from flask import Flask, jsonify, request

app = Flask(__name__)

# Only files under here may be transcribed. The id comes from a URL, so
# without this a crafted path could read anything the service user can.
CACHE_DIR = os.path.realpath(
    os.environ.get('CACHE_DIR',
                   os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')))

MODEL_SIZE = os.environ.get('WHISPER_MODEL', 'large-v3')
# int8_float16 halves VRAM against float16 with no measurable accuracy cost
# on this workload, and leaves headroom on a 6 GB card for anything else.
COMPUTE_TYPE = os.environ.get('WHISPER_COMPUTE', 'int8_float16')
DEVICE = os.environ.get('WHISPER_DEVICE', 'cuda')

# Segments whose no_speech_prob exceeds this are dropped. Whisper is a speech
# model: handed an instrumental intro or a guitar solo it will still emit its
# best guess, and that guess is confident-looking garbage. Measured on a known
# instrumental, this threshold takes it from 18 invented words to none.
NO_SPEECH_MAX = float(os.environ.get('WHISPER_NO_SPEECH_MAX', '0.6'))

_model = None
_load_error = None
_load_seconds = None


def get_model():
    global _model, _load_error, _load_seconds
    if _model is None and _load_error is None:
        try:
            from faster_whisper import WhisperModel
            t0 = time.time()
            _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
            _load_seconds = round(time.time() - t0, 1)
        except Exception as exc:  # noqa: BLE001 - reported over HTTP, not raised
            _load_error = f'{type(exc).__name__}: {exc}'
    return _model


def _norm(text):
    return re.sub(r'[^a-z0-9 ]', '', text.lower()).strip()


# Whisper was trained heavily on YouTube captions, so when it is handed audio
# with no speech in it, the filler it reaches for is caption boilerplate --
# "Thanks for watching!", "Thank you.", subscribe prompts. That makes this a
# small enumerable artifact class rather than generic misrecognition, which is
# why a blocklist is the right tool here and a confidence threshold is not:
# measured on real audio, a hallucinated "Thanks for watching!" scored
# no_speech_prob 0.59 while a genuine sung line scored 0.49. No threshold fits
# in that gap without breaking on the next song.
#
# The tradeoff is explicit: a song whose entire sung line is exactly one of
# these phrases loses that line. That is a real cost, accepted because silent
# filler painted across an instrumental is worse than one missing line.
_CAPTION_FILLER = {
    'thank you', 'thanks', 'thank you very much', 'thanks for watching',
    'thank you for watching', 'thanks for watching everyone', 'please subscribe',
    'subscribe', 'like and subscribe', 'subscribe to my channel',
    'see you next time', 'see you in the next video', 'bye', 'bye bye',
    'you', 'amen', 'the end', 'music', 'applause', 'outro',
}


def _drop_caption_filler(segments):
    return [s for s in segments if _norm(s['text']) not in _CAPTION_FILLER]


def _drop_repetition_loops(segments):
    # Whisper hallucinates in loops: each invented line becomes the context
    # that primes the next one, so non-speech audio produces the SAME short
    # phrase over and over ("Thank you." six times across a 4-minute
    # instrumental). Real lyrics repeat too -- a chorus hook -- but not as a
    # short phrase recurring many times with nothing else between. Keying on
    # the repetition rather than on a blocklist of known hallucinations means
    # this keeps working for phrases nobody has catalogued yet.
    counts = Counter(_norm(s['text']) for s in segments)
    return [s for s in segments
            if not (counts[_norm(s['text'])] >= 3 and len(_norm(s['text'])) <= 25)]


@app.route('/health', methods=['GET'])
def health():
    m = get_model()
    return jsonify(
        ok=m is not None,
        model=MODEL_SIZE,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        load_seconds=_load_seconds,
        error=_load_error,
    )


@app.route('/transcribe', methods=['POST'])
def transcribe():
    body = request.get_json(silent=True) or {}
    path = body.get('path') or ''

    # Confine to the cache directory. realpath first so symlinks and ../
    # are resolved before the prefix check, not after.
    real = os.path.realpath(path)
    if not real.startswith(CACHE_DIR + os.sep) or not os.path.isfile(real):
        return jsonify(ok=False, error='unknown audio path'), 404

    model = get_model()
    if model is None:
        return jsonify(ok=False, error=f'model unavailable: {_load_error}'), 503

    t0 = time.time()
    try:
        segs, info = model.transcribe(
            real,
            word_timestamps=True,
            # MUST stay False. Silero VAD is a speech detector; handed a full
            # musical mix it classifies the entire file as non-speech and
            # discards it, yielding zero segments on tracks with clear vocals.
            vad_filter=False,
            # Stops a hallucinated line from priming the next one, which is
            # what turns one bad guess into a repetition loop.
            condition_on_previous_text=False,
            no_speech_threshold=NO_SPEECH_MAX,
            log_prob_threshold=-1.0,
            compression_ratio_threshold=2.0,
            language=body.get('language') or None,
        )
        out = []
        for s in segs:
            if s.no_speech_prob >= NO_SPEECH_MAX:
                continue
            text = (s.text or '').strip()
            if not text:
                continue
            out.append({
                'start': round(s.start, 2),
                'end': round(s.end, 2),
                'text': text,
                'words': [{'start': round(w.start, 2),
                           'end': round(w.end, 2),
                           'word': w.word.strip()}
                          for w in (s.words or [])],
            })
        out = _drop_repetition_loops(_drop_caption_filler(out))
    except Exception as exc:  # noqa: BLE001
        app.logger.exception('transcription failed')
        return jsonify(ok=False, error=f'{type(exc).__name__}: {exc}'), 500

    return jsonify(
        ok=True,
        segments=out,
        language=info.language,
        language_probability=round(info.language_probability, 3),
        model=MODEL_SIZE,
        elapsed=round(time.time() - t0, 1),
    )


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5006)
