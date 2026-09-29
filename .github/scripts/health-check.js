#!/usr/bin/env node
/**
 * Polls the Song Analyzer's /health from OUTSIDE the network it monitors.
 *
 * That placement is the whole point. A checker running on the XPS cannot
 * report the one failure that matters most -- the box being off, the tunnel
 * being down, the house losing power. Monitoring has to sit somewhere that
 * stays up when the thing it watches does not.
 *
 * Alerts fire on STATE CHANGE, not on every failing poll. A check every 15
 * minutes that mails on each failure turns a two-hour outage into eight
 * identical emails, and the reliable result of that is a filter rule and a
 * missed outage later. One mail when it breaks, one when it recovers.
 *
 * Three states:
 *   ok        reachable, ok:true, nothing degraded
 *   degraded  answering, but a subsystem is down -- YouTube failing, lyrics
 *             sidecar unreachable. The site works; a feature does not.
 *   down      unreachable, non-200, or ok:false
 */
const fs = require('fs');
const path = require('path');

const URL_ = process.env.HEALTH_URL || 'https://api.methodictruth.com/health';
const STATE = path.join(__dirname, '..', '..', 'monitoring', 'state.json');
const TIMEOUT_MS = 20000;

async function probe() {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(URL_, { signal: ctrl.signal });
    clearTimeout(t);
    const ms = Date.now() - started;

    if (!res.ok) {
      return { state: 'down', ms, detail: `HTTP ${res.status} from /health` };
    }
    let h;
    try { h = await res.json(); }
    catch { return { state: 'down', ms, detail: 'response was not JSON' }; }

    if (!h.ok) return { state: 'down', ms, detail: 'health reports ok:false', health: h };

    const problems = [];
    if (h.youtube === 'failing') {
      problems.push(`YouTube downloads failing (${h.youtube_consecutive_failures || '?'} consecutive)` +
                    (h.youtube_last_error ? ` — ${String(h.youtube_last_error).slice(0, 180)}` : ''));
    }
    if (h.lyrics_enabled && h.lyrics_service_up === false) {
      problems.push('lyrics sidecar unreachable (GPU transcription unavailable)');
    }
    if (h.ffmpeg === false) problems.push('ffmpeg missing');

    return problems.length
      ? { state: 'degraded', ms, detail: problems.join('; '), health: h }
      : { state: 'ok', ms, detail: 'all subsystems reporting', health: h };
  } catch (e) {
    const ms = Date.now() - started;
    const why = e.name === 'AbortError'
      ? `no response within ${TIMEOUT_MS / 1000}s`
      : `${e.name}: ${e.message}`;
    // Unreachable is the interesting case: the tunnel, the host or the
    // connection, rather than the application.
    return { state: 'down', ms, detail: why };
  }
}

function summarise(h) {
  if (!h) return '';
  const f = (k, label) => h[k] === undefined ? null : `${label}: ${h[k]}`;
  return [
    f('cached_songs', 'cached songs'),
    f('youtube', 'youtube'),
    f('lyrics_service_up', 'lyrics service'),
    f('lyrics_model', 'model'),
    f('analysis_slots', 'analysis slots'),
    f('ytdlp_version', 'yt-dlp'),
    h.js_runtime_deno !== undefined ? `js runtime: ${h.js_runtime_deno ? 'deno' : (h.js_runtime_node ? 'node' : 'NONE')}` : null,
  ].filter(Boolean).join('\n  ');
}

(async () => {
  const now = new Date().toISOString();
  const r = await probe();

  let prev = { state: 'ok', since: now };
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}

  const changed = prev.state !== r.state;
  const next = {
    state: r.state,
    since: changed ? now : (prev.since || now),
    lastChecked: now,
    lastDetail: r.detail,
    responseMs: r.ms,
  };
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(next, null, 1) + '\n');

  let subject = '', body = '';
  if (changed) {
    const mins = Math.round((Date.parse(now) - Date.parse(prev.since || now)) / 60000);
    if (r.state === 'ok') {
      subject = '[Methodic Truth] RECOVERED — analyzer back to normal';
      body = `The Song Analyzer is healthy again.\n\n` +
             `Previous state: ${prev.state} for about ${mins} minutes.\n` +
             `Was: ${prev.lastDetail || 'unknown'}\n\n  ${summarise(r.health)}\n`;
    } else {
      subject = r.state === 'down'
        ? '[Methodic Truth] DOWN — analyzer not responding'
        : '[Methodic Truth] DEGRADED — a feature is broken';
      body = `${r.state === 'down'
        ? 'The analyzer API is not answering.'
        : 'The analyzer is up but something is broken.'}\n\n` +
             `What: ${r.detail}\nChecked: ${now}\nURL: ${URL_}\n` +
             `Response time: ${r.ms} ms\n\n` +
             (r.health ? `  ${summarise(r.health)}\n\n` : '') +
             (r.state === 'down'
               ? `Most likely: the XPS is off or asleep, cloudflared has stopped, or the\n` +
                 `house connection is down. Check in that order.\n`
               : `The site still works; this feature does not.\n`);
    }
  }

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    const eof = 'EOF_' + Math.random().toString(36).slice(2);
    fs.appendFileSync(out,
      `state=${r.state}\nchanged=${changed}\n` +
      `subject=${subject}\n` +
      `body<<${eof}\n${body}\n${eof}\n`);
  }

  console.log(`state=${r.state} (${r.ms}ms) changed=${changed} :: ${r.detail}`);
  // Never fail the job on an unhealthy site -- a red X every 15 minutes is
  // its own alert storm, and the email is the signal.
  process.exit(0);
})();
