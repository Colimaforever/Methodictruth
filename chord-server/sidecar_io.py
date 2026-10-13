"""
How a sidecar gets hold of the audio it was asked about.

Both sidecars were written when they shared a machine with the analyzer, so
both take an absolute path and read it directly. That is correct and free while
the cache is on the same disk. It silently stops being correct the moment the
analyzer moves to another host: the path still looks valid, the file simply is
not there, and the sidecar answers "unknown audio path" to every request while
its own /health keeps reporting fine.

So a request may carry either:

    {"path": "/…/cache/<id>.mp3"}   read directly, when co-located
    {"url":  "http://…/audio/<id>"} fetched, when not

`path` is tried first because a local read beats a LAN round trip, and a host
that has both gets the fast one without being told.

Fetching is opt-in and prefix-restricted. A service that downloads whatever URL
it is handed, then runs a model on the result, is server-side request forgery
with extra steps -- so FETCH_PREFIX starts empty, and only URLs beginning with
it are ever fetched.
"""
import contextlib
import os
import shutil
import tempfile
import urllib.request

# Audio files are a few MB. Anything far past that is not a song, and a sidecar
# should not be the thing that discovers it has no disk left.
MAX_FETCH_BYTES = int(os.environ.get('MAX_FETCH_BYTES', str(200 * 1024 * 1024)))


def resolve_local(path, cache_dir):
    # realpath before the prefix check so symlinks and ../ are resolved first,
    # not after. At least one host has the cache as a symlink, so both sides
    # must be resolved to compare meaningfully.
    real = os.path.realpath(path or '')
    if not real.startswith(cache_dir.rstrip(os.sep) + os.sep) or not os.path.isfile(real):
        return None
    return real


@contextlib.contextmanager
def source(body, cache_dir, fetch_prefix='', timeout=120):
    """Yield a readable local path for this request, or None if there isn't one.

    A fetched file is deleted on the way out; a local one is left alone.
    """
    local = resolve_local((body or {}).get('path'), cache_dir)
    if local:
        yield local
        return

    url = ((body or {}).get('url') or '').strip()
    if not url or not fetch_prefix or not url.startswith(fetch_prefix):
        yield None
        return

    tmpdir = tempfile.mkdtemp(prefix='sidecar-audio-')
    try:
        dest = os.path.join(tmpdir, 'audio')
        written = 0
        with urllib.request.urlopen(url, timeout=timeout) as r, open(dest, 'wb') as fh:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_FETCH_BYTES:
                    raise ValueError(f'audio exceeds {MAX_FETCH_BYTES} bytes')
                fh.write(chunk)
        yield dest if written else None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
