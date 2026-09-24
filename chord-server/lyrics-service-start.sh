#!/bin/sh
# Launcher for the GPU transcription sidecar.
#
# CTranslate2 (faster-whisper's backend) needs cuDNN 9 at load time, and the
# only copy on the box is the one bundled inside torch's wheel under
# site-packages/nvidia/*/lib. It does not look there on its own -- without
# this the service dies at model load with "Unable to load libcudnn_ops.so.9".
# Computing the path at launch rather than hardcoding it means a torch or
# CUDA upgrade that moves those directories doesn't silently break the unit.
set -eu

VENV="${ML_VENV:-$HOME/ml-venv}"

LD_LIBRARY_PATH="$("$VENV/bin/python" - <<'PY'
import os
try:
    import nvidia
    base = os.path.dirname(nvidia.__file__)
    print(':'.join(os.path.join(base, d, 'lib') for d in sorted(os.listdir(base))
                   if os.path.isdir(os.path.join(base, d, 'lib'))))
except Exception:
    print('')
PY
)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export LD_LIBRARY_PATH

# One worker, deliberately: it is what keeps a single ~3 GB model resident on
# a 6 GB card and serializes GPU access without needing a lock.
exec "$VENV/bin/gunicorn" -w 1 --timeout 600 \
     -b 127.0.0.1:5006 lyrics_service:app
