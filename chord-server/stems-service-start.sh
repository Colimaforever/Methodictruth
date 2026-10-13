#!/bin/sh
# Launcher for the stem separation / transcription sidecar.
#
# Deliberately plainer than lyrics-service-start.sh: Demucs runs through
# torch's own CUDA stack rather than CTranslate2, so there is no cuDNN path to
# reconstruct. If that ever changes, copy the LD_LIBRARY_PATH block from the
# lyrics launcher rather than hardcoding a path -- it survives torch upgrades
# that move those directories.
set -eu

VENV="${STEMS_VENV:-$HOME/stems-venv}"

# One worker, for the same reason the lyrics service uses one: it keeps a
# single copy of the separation model on the card and serialises GPU access
# without a lock. Two workers on a 4 GB card is an out-of-memory error waiting
# for two people to click at once.
#
# The timeout is 30 minutes rather than 10. Separation plus four
# transcriptions on a laptop GPU is minutes, and a long first run on a cold
# cache should not be killed halfway through work that would have been cached.
exec "$VENV/bin/gunicorn" -w 1 --timeout 1800 \
     -b 127.0.0.1:5007 stems_service:app
