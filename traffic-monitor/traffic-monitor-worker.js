/**
 * Cloudflare Worker: traffic surge detector for methodictruth.com
 *
 * Runs on a cron schedule. Pulls recent `session_start` events from the
 * Firebase Realtime Database the site already logs to (see analytics.js),
 * compares the last 10 minutes against the trailing hourly average, and
 * emails an alert when traffic spikes well above normal.
 */

import { EmailMessage } from 'cloudflare:email';

const FIREBASE_BASE = 'https://methodictruth-default-rtdb.firebaseio.com';

const RECENT_WINDOW_MS = 10 * 60 * 1000;      // "right now" window
const BASELINE_WINDOW_MS = 60 * 60 * 1000;    // trailing window used as the baseline
const BASELINE_BUCKETS = BASELINE_WINDOW_MS / RECENT_WINDOW_MS;

const MIN_RECENT_SESSIONS = 5;   // floor — don't alert on quiet-period noise
const SURGE_MULTIPLIER = 3;      // recent must be this many times the baseline average
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // don't re-alert more than once/hour during a sustained surge

const FROM_ADDRESS = 'alerts@methodictruth.com';
const TO_ADDRESS = 'sergmacedo1@gmail.com';

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkTraffic(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/check') {
      const result = await checkTraffic(env, url.searchParams.has('force'));
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('traffic-monitor: see /check', { status: 200 });
  },
};

async function fetchEventsSince(sinceMs) {
  const url = `${FIREBASE_BASE}/analytics/events.json?orderBy="timestamp"&startAt=${sinceMs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase fetch failed: ${res.status}`);
  const data = await res.json();
  return data ? Object.values(data) : [];
}

async function checkTraffic(env, force) {
  const now = Date.now();
  const events = await fetchEventsSince(now - BASELINE_WINDOW_MS - RECENT_WINDOW_MS);
  const sessionStarts = events.filter(e => e && e.event === 'session_start' && typeof e.timestamp === 'number');

  const recentCutoff = now - RECENT_WINDOW_MS;
  const recent = sessionStarts.filter(e => e.timestamp >= recentCutoff);
  const baseline = sessionStarts.filter(e => e.timestamp < recentCutoff);

  const recentCount = recent.length;
  const baselineAvg = baseline.length / BASELINE_BUCKETS;

  const ratio = baselineAvg > 0 ? recentCount / baselineAvg : (recentCount >= MIN_RECENT_SESSIONS ? Infinity : 0);
  const isSurge = recentCount >= MIN_RECENT_SESSIONS && ratio >= SURGE_MULTIPLIER;

  const result = {
    checkedAt: new Date(now).toISOString(),
    recentCount,
    baselineAvgPer10Min: Math.round(baselineAvg * 10) / 10,
    ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : 'inf',
    isSurge,
  };

  if (isSurge || force) {
    const lastAlert = await env.TRAFFIC_KV.get('lastAlertAt');
    const cooledDown = !lastAlert || (now - Number(lastAlert)) > ALERT_COOLDOWN_MS;
    result.cooledDown = cooledDown;

    if (cooledDown) {
      await sendAlertEmail(env, result, recent);
      await env.TRAFFIC_KV.put('lastAlertAt', String(now));
      result.alertSent = true;
    } else {
      result.alertSent = false;
    }
  }

  return result;
}

function topPages(events) {
  const counts = {};
  for (const e of events) {
    const page = e.page || '(unknown)';
    counts[page] = (counts[page] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
}

async function sendAlertEmail(env, stats, recentEvents) {
  const pageLines = topPages(recentEvents)
    .map(([page, count]) => `  ${page}: ${count}`)
    .join('\n') || '  (no page data)';

  const body =
    `Traffic surge detected on methodictruth.com\n\n` +
    `Sessions in the last 10 minutes: ${stats.recentCount}\n` +
    `Trailing hourly average (per 10 min): ${stats.baselineAvgPer10Min}\n` +
    `Ratio vs. normal: ${stats.ratio}x\n\n` +
    `Top pages right now:\n${pageLines}\n`;

  const raw =
    `From: Methodic Truth Alerts <${FROM_ADDRESS}>\r\n` +
    `To: ${TO_ADDRESS}\r\n` +
    `Subject: Traffic surge on methodictruth.com (${stats.ratio}x normal)\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    body;

  const msg = new EmailMessage(FROM_ADDRESS, TO_ADDRESS, raw);
  await env.SEND_EMAIL.send(msg);
}
