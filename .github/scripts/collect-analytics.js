#!/usr/bin/env node
/**
 * Collects site analytics into the repository.
 *
 * Why the repo and not an endpoint: the agent working on this site runs in a
 * sandbox whose egress policy blocks every host except GitHub. It cannot reach
 * methodictruth.com, api.methodictruth.com, Firebase or Cloudflare's API. So a
 * /health-style endpoint, however good, is invisible to it -- someone has to
 * copy the output by hand. Writing the numbers into the repo puts them on the
 * one channel that does get through.
 *
 * Two outputs, deliberately:
 *   analytics/history.json  append-only daily rows -- the part that makes
 *                           "is it growing?" answerable at all. A single
 *                           snapshot only ever shows shape.
 *   analytics/REPORT.md     the same data as prose, for humans.
 *
 * Privacy: the Firebase beacon records user-agent, referrer and a per-browser
 * id. This repository is public, so only AGGREGATES are written here -- counts
 * per page and per referrer host. Raw rows never leave Firebase.
 *
 * Degrades rather than fails: a missing secret produces a report that says
 * which source was unavailable, so a partial run is still useful and the
 * absence is visible instead of silent.
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'analytics');
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CF_ZONE = process.env.CLOUDFLARE_ZONE_ID || '';
const FB_URL = process.env.FIREBASE_DB_URL ||
  'https://methodictruth-default-rtdb.firebaseio.com';

const day = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const since = new Date(today.getTime() - 60 * 864e5);

async function cloudflare() {
  if (!CF_TOKEN || !CF_ZONE) {
    return { ok: false, error: 'CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not set' };
  }
  const query = `query($zone:String!,$since:String!,$until:String!){
    viewer{ zones(filter:{zoneTag:$zone}){
      httpRequests1dGroups(limit:60, orderBy:[date_ASC],
        filter:{date_geq:$since, date_leq:$until}){
        dimensions{ date }
        sum{ requests cachedRequests bytes cachedBytes pageViews }
        uniq{ uniques }
      } } } }`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { zone: CF_ZONE, since: day(since), until: day(today) } }),
    });
    const j = await res.json();
    if (j.errors?.length) return { ok: false, error: j.errors[0].message };
    const rows = j.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
    return {
      ok: true,
      days: rows.map(r => ({
        date: r.dimensions.date,
        requests: r.sum.requests,
        cached: r.sum.cachedRequests,
        bytes: r.sum.bytes,
        pageViews: r.sum.pageViews,
        uniques: r.uniq.uniques,
      })),
    };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}` };
  }
}

async function firebase() {
  // Most recent records only. orderBy="$key" needs no index rule, so this
  // works against default database rules.
  // A database secret is only needed if the rules deny public read. The beacon
  // writes without auth, but write-only rules are the sane configuration for a
  // public site -- otherwise anyone could read every visitor record.
  const auth = process.env.FIREBASE_AUTH ? `&auth=${encodeURIComponent(process.env.FIREBASE_AUTH)}` : '';
  const url = `${FB_URL}/analytics/views.json?orderBy=%22%24key%22&limitToLast=20000${auth}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      // 401 and 403 mean different things here and lead to different fixes.
      // 401: no credential was presented, or it was rejected outright — the
      // rules were never consulted, so "rules deny read" is the wrong advice.
      // 403: the credential was accepted and the rules then said no.
      const hint = res.status === 401
        ? ' (no credential accepted — FIREBASE_AUTH is unset or wrong)'
        : res.status === 403
          ? ' (credential accepted, rules deny read — widen the read rule for /analytics)'
          : '';
      return { ok: false, error: `HTTP ${res.status}${hint}` };
    }
    const data = await res.json();
    if (!data) return { ok: true, total: 0, pages: {}, referrers: {}, daily: {} };

    const pages = {}, referrers = {}, daily = {}, visitors = new Set();
    for (const row of Object.values(data)) {
      if (!row || typeof row !== 'object') continue;
      const p = String(row.page || 'unknown').slice(0, 80);
      pages[p] = (pages[p] || 0) + 1;

      let ref = 'direct';
      if (row.ref && row.ref !== 'direct') {
        try { ref = new URL(row.ref).hostname; } catch { ref = 'other'; }
      }
      // Host only -- never the full referring URL, which can carry queries.
      referrers[ref] = (referrers[ref] || 0) + 1;

      if (row.ts) daily[day(new Date(row.ts))] = (daily[day(new Date(row.ts))] || 0) + 1;
      if (row.visitor) visitors.add(row.visitor);
    }
    return { ok: true, total: Object.keys(data).length,
             uniqueVisitors: visitors.size, pages, referrers, daily };
  } catch (e) {
    return { ok: false, error: `${e.name}: ${e.message}` };
  }
}

const sumOver = (days, n, key) =>
  days.slice(-n).reduce((a, d) => a + (d[key] || 0), 0);

const top = (obj, n) =>
  Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

function trend(days) {
  if (days.length < 14) return null;
  const half = Math.min(30, Math.floor(days.length / 2));
  const recent = sumOver(days, half, 'requests');
  const prior = days.slice(-(half * 2), -half).reduce((a, d) => a + d.requests, 0);
  if (!prior) return null;
  return { half, recent, prior, pct: ((recent - prior) / prior) * 100 };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const [cf, fb] = await Promise.all([cloudflare(), firebase()]);
  const stamp = new Date().toISOString();

  // ---- append-only history -------------------------------------------
  const histPath = path.join(OUT, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(histPath, 'utf8')); } catch {}
  const byDate = new Map(hist.map(r => [r.date, r]));
  if (cf.ok) {
    for (const d of cf.days) {
      byDate.set(d.date, { ...(byDate.get(d.date) || {}), ...d });
    }
  }
  if (fb.ok) {
    for (const [date, beacons] of Object.entries(fb.daily)) {
      byDate.set(date, { ...(byDate.get(date) || { date }), beacons });
    }
  }
  hist = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(histPath, JSON.stringify(hist, null, 1) + '\n');

  // ---- machine-readable snapshot --------------------------------------
  fs.writeFileSync(path.join(OUT, 'latest.json'),
    JSON.stringify({ collected: stamp, cloudflare: cf, firebase: fb }, null, 1) + '\n');

  // ---- human report ----------------------------------------------------
  const L = [];
  L.push('# Traffic report');
  L.push('');
  L.push(`Collected **${stamp}** · regenerated by \`.github/workflows/analytics.yml\`.`);
  L.push('Aggregates only — no raw visitor records are stored in this repository.');
  L.push('');

  // A collector that reports "unavailable" in a footnote every day, exits 0 and
  // commits a green run looks healthy while measuring nothing. Say it at the
  // top, name the fix, and fail the run so the Actions tab shows it too.
  const blind = !cf.ok && !fb.ok;
  if (blind) {
    L.push('> ## ⚠ No traffic data is being collected');
    L.push('>');
    L.push('> **Both sources are unreachable, so this report is empty and the');
    L.push('> history below it is not growing.** Nothing here says anything about');
    L.push('> whether people are visiting — it only says we cannot see.');
    L.push('>');
    L.push('> The fix is two repository secrets, in');
    L.push('> *Settings → Secrets and variables → Actions*:');
    L.push('>');
    L.push('> | Secret | Where it comes from |');
    L.push('> | --- | --- |');
    L.push('> | `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → *Read analytics and logs* template, scoped to this zone |');
    L.push('> | `CLOUDFLARE_ZONE_ID` | Cloudflare → the `methodictruth.com` zone → Overview, right-hand column |');
    L.push('>');
    L.push('> Cloudflare alone answers the question, and it sees every request —');
    L.push('> including visitors who never run JavaScript, which the on-site');
    L.push('> beacon cannot count. `FIREBASE_AUTH` is optional and only adds');
    L.push('> per-page and per-referrer detail.');
    L.push('');
  }

  if (cf.ok && cf.days.length) {
    const d = cf.days;
    const r30 = sumOver(d, 30, 'requests'), c30 = sumOver(d, 30, 'cached');
    L.push('## Cloudflare');
    L.push('');
    L.push('| Window | Requests | Uniques | Cache hit | Bandwidth |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const n of [7, 30]) {
      const req = sumOver(d, n, 'requests'), ca = sumOver(d, n, 'cached');
      L.push(`| ${n}d | ${req.toLocaleString()} | ${sumOver(d, n, 'uniques').toLocaleString()} | ` +
             `${req ? ((ca / req) * 100).toFixed(1) : '0'}% | ` +
             `${(sumOver(d, n, 'bytes') / 1e9).toFixed(2)} GB |`);
    }
    L.push('');
    const t = trend(d);
    if (t) {
      const dir = t.pct >= 0 ? 'up' : 'down';
      L.push(`**Trend:** last ${t.half} days ${t.recent.toLocaleString()} requests vs ` +
             `${t.prior.toLocaleString()} in the ${t.half} before — ` +
             `**${dir} ${Math.abs(t.pct).toFixed(1)}%**.`);
    } else {
      L.push('**Trend:** not enough history yet — needs two comparable windows.');
    }
    L.push('');
    L.push('<details><summary>Daily requests</summary>');
    L.push('');
    L.push('| Date | Requests | Cached | Uniques |');
    L.push('| --- | --- | --- | --- |');
    for (const x of d.slice(-30)) {
      L.push(`| ${x.date} | ${x.requests} | ${x.cached} | ${x.uniques} |`);
    }
    L.push('');
    L.push('</details>');
  } else {
    L.push('## Cloudflare');
    L.push('');
    L.push(`Unavailable — ${cf.error}.`);
  }
  L.push('');

  if (fb.ok) {
    L.push('## On-site beacon');
    L.push('');
    L.push(`${fb.total.toLocaleString()} pageviews in the sampled window from ` +
           `${(fb.uniqueVisitors || 0).toLocaleString()} distinct browsers.`);
    L.push('');
    L.push('| Page | Views |');
    L.push('| --- | --- |');
    for (const [p, n] of top(fb.pages, 20)) L.push(`| \`${p}\` | ${n} |`);
    L.push('');
    L.push('| Referrer | Views |');
    L.push('| --- | --- |');
    for (const [r, n] of top(fb.referrers, 12)) L.push(`| ${r} | ${n} |`);
  } else {
    L.push('## On-site beacon');
    L.push('');
    L.push(`Unavailable — ${fb.error}.`);
  }
  L.push('');

  fs.writeFileSync(path.join(OUT, 'REPORT.md'), L.join('\n') + '\n');
  console.log(`cloudflare: ${cf.ok ? cf.days.length + ' days' : 'FAILED — ' + cf.error}`);
  console.log(`firebase:   ${fb.ok ? fb.total + ' rows' : 'FAILED — ' + fb.error}`);
  console.log(`history:    ${hist.length} days on file`);

  if (blind) {
    console.error('\nNo source returned data. The report was still written (and the ' +
      'workflow still commits it) but it contains no traffic. Failing the run so ' +
      'this is visible in the Actions tab rather than passing quietly.');
    process.exitCode = 1;
  }
})();
