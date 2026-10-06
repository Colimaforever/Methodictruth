#!/usr/bin/env node
/**
 * Builds the weekly traffic email.
 *
 * Weekly, not daily, on purpose. Day-to-day numbers on a site this size are
 * mostly noise -- one crawler, one shared link, and a day swings by a factor
 * of three while nothing real has changed. Percentages on small numbers lie
 * loudest of all: three visitors to six is "+100%" and means nothing. A week
 * is long enough that a change in it is usually a change in the world rather
 * than in the weather, and it arrives at a rate that stays worth opening.
 *
 * Reads what `collect-analytics.js` leaves behind:
 *   analytics/history.json  append-only daily rows (committed, so it survives)
 *   analytics/latest.json   the last raw payload, including per-page and
 *                           per-referrer breakdowns (gitignored -- the weekly
 *                           workflow runs the collector first to produce it)
 *
 * Emits GITHUB_OUTPUT: send=true|false, subject, html, text.
 * When there is nothing to report it sets send=false rather than mailing an
 * empty page. An automated message that arrives every week and says nothing
 * teaches you to ignore the one that eventually says something.
 *
 * Email constraints shape the markup, not taste:
 *   - Tables and inline styles only. Gmail strips <style> blocks and any SVG,
 *     so charts are table cells with a background colour and a pixel width.
 *   - Pixel widths, not percentages -- Outlook is unreliable with the latter.
 *   - Explicit background and text colours on every block, so a client's dark
 *     mode inversion cannot produce dark text on a dark card.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'analytics');
const SITE = 'methodictruth.com';
const BAR_MAX_PX = 260;

// --- palette -------------------------------------------------------------
const INK = '#1a1d26';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';
const CARD = '#ffffff';
const PAGE_BG = '#f4f5f7';
const ACCENT = '#2563eb';
const UP = '#047857';
const DOWN = '#b45309';

const read = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
  catch { return fallback; }
};

const esc = (s) => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const day = (d) => d.toISOString().slice(0, 10);
const nf = (n) => Number(n || 0).toLocaleString('en-US');

/** Visits for a row, preferring Cloudflare's pageViews, then the beacon. */
const visits = (r) =>
  r.pageViews != null ? r.pageViews
  : r.beacons != null ? r.beacons
  : r.requests != null ? r.requests : 0;

/** The n days ending yesterday, offset whole weeks back. */
function window_(hist, weeksAgo) {
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1 - weeksAgo * 7);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 6);
  const a = day(start), b = day(end);
  return hist.filter(r => r.date >= a && r.date <= b);
}

const sum = (rows, f) => rows.reduce((t, r) => t + (f(r) || 0), 0);

/** Plain language beats a percentage when the base is tiny. */
function verdict(now, before) {
  if (!before && !now) return { word: 'no visits recorded', colour: MUTED, pct: null };
  if (!before) return { word: 'first week with traffic', colour: UP, pct: null };
  const pct = ((now - before) / before) * 100;
  if (now < 25 && before < 25) {
    const d = now - before;
    if (d === 0) return { word: 'level with last week', colour: MUTED, pct: null };
    return { word: `${d > 0 ? 'up' : 'down'} ${Math.abs(d)} on last week`,
             colour: d > 0 ? UP : DOWN, pct: null };
  }
  if (Math.abs(pct) < 5) return { word: 'flat on last week', colour: MUTED, pct };
  return { word: `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% on last week`,
           colour: pct > 0 ? UP : DOWN, pct };
}

const SEARCH = /(google|bing|duckduckgo|yahoo|ecosia|brave|yandex|baidu|startpage|qwant)\./i;
const SOCIAL = /(reddit|t\.co|twitter|x\.com|facebook|instagram|youtube|linkedin|news\.ycombinator|lemmy|mastodon|bsky)/i;

// --- html helpers --------------------------------------------------------
const h2 = (t) => `<tr><td style="padding:26px 24px 8px;background:${CARD};">` +
  `<div style="font:600 12px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;` +
  `letter-spacing:.11em;text-transform:uppercase;color:${MUTED};">${esc(t)}</div></td></tr>`;

const note = (t) => `<tr><td style="padding:0 24px 14px;background:${CARD};` +
  `font:400 13px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${MUTED};">${t}</td></tr>`;

function table(headers, rows, aligns = []) {
  if (!rows.length) return '';
  const th = headers.map((x, i) =>
    `<th align="${aligns[i] || 'left'}" style="padding:7px 10px;border-bottom:1px solid ${RULE};` +
    `font:600 11px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;letter-spacing:.07em;` +
    `text-transform:uppercase;color:${MUTED};">${esc(x)}</th>`).join('');
  const tr = rows.map(cells => '<tr>' + cells.map((c, i) =>
    `<td align="${aligns[i] || 'left'}" style="padding:8px 10px;border-bottom:1px solid ${RULE};` +
    `font:400 14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">${c}</td>`
  ).join('') + '</tr>').join('');
  return `<tr><td style="padding:0 24px 8px;background:${CARD};">` +
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation">` +
    `<tr>${th}</tr>${tr}</table></td></tr>`;
}

/** A bar chart made of table cells, because every email client can draw those. */
function chart(rows) {
  if (!rows.length) return '';
  const peak = Math.max(...rows.map(visits), 1);
  const body = rows.map(r => {
    const v = visits(r);
    const w = Math.max(v > 0 ? 3 : 1, Math.round((v / peak) * BAR_MAX_PX));
    const d = new Date(r.date + 'T00:00:00Z');
    const label = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    const isPeak = v === peak && v > 0;
    return `<tr>` +
      `<td style="padding:3px 10px 3px 0;white-space:nowrap;font:400 12px/1.3 ` +
      `-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${MUTED};">${label} ${r.date.slice(5)}</td>` +
      `<td style="padding:3px 0;" width="${BAR_MAX_PX}">` +
        `<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>` +
        `<td width="${w}" height="13" style="width:${w}px;height:13px;background:${isPeak ? ACCENT : '#9db4e8'};` +
        `border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td>` +
      `<td align="right" style="padding:3px 0 3px 10px;white-space:nowrap;font:600 13px/1.3 ` +
      `-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">${nf(v)}</td>` +
      `</tr>`;
  }).join('');
  return `<tr><td style="padding:0 24px 10px;background:${CARD};">` +
    `<table cellpadding="0" cellspacing="0" border="0" role="presentation">${body}</table></td></tr>`;
}

// --- main ----------------------------------------------------------------
(() => {
  const hist = read('history.json', []);
  const latest = read('latest.json', {});
  const fb = latest.firebase && latest.firebase.ok ? latest.firebase : null;

  const thisWeek = window_(hist, 0);
  const lastWeek = window_(hist, 1);
  const now = sum(thisWeek, visits);
  const before = sum(lastWeek, visits);

  const out = process.env.GITHUB_OUTPUT;
  // The HTML is emitted as one long line, so `key=value` would technically
  // work -- but a single stray newline appearing in it later would silently
  // truncate the output and mail a half-page. Anything long or multi-line gets
  // the heredoc form, which has no such edge.
  const emit = (kv) => {
    if (!out) return;
    let s = '';
    for (const [k, val] of Object.entries(kv)) {
      const v = String(val);
      if (v.includes('\n') || v.length > 200) {
        const eof = 'EOF_' + Math.random().toString(36).slice(2);
        s += `${k}<<${eof}\n${v}\n${eof}\n`;
      } else s += `${k}=${v}\n`;
    }
    fs.appendFileSync(out, s);
  };

  // Nothing collected means nothing to say. Not mailing is the feature: a
  // weekly empty page trains you to filter the address, and then the first
  // real report goes unread too.
  if (!thisWeek.length && !fb) {
    console.log('No data for the past week — not sending. ' +
      (hist.length ? `History has ${hist.length} rows but none in range.`
                   : 'History is empty; the collector has no sources configured.'));
    emit({ send: 'false' });
    return;
  }

  const v = verdict(now, before);
  const peakRow = thisWeek.slice().sort((a, b) => visits(b) - visits(a))[0];
  const uniques = sum(thisWeek, r => r.uniques);
  const bytes = sum(thisWeek, r => r.bytes);
  const req = sum(thisWeek, r => r.requests);
  const cached = sum(thisWeek, r => r.cached);

  const H = [];
  H.push(`<tr><td style="padding:28px 24px 2px;background:${CARD};">` +
    `<div style="font:700 19px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">` +
    `${esc(SITE)} — week in review</div>` +
    `<div style="padding-top:4px;font:400 13px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${MUTED};">` +
    `${thisWeek.length ? esc(thisWeek[0].date) + ' to ' + esc(thisWeek[thisWeek.length - 1].date) : 'last 7 days'}</div></td></tr>`);

  H.push(`<tr><td style="padding:18px 24px 6px;background:${CARD};">` +
    `<div style="font:700 42px/1.05 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${INK};">${nf(now)}</div>` +
    `<div style="padding-top:6px;font:600 15px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${v.colour};">` +
    `visits · ${esc(v.word)}</div></td></tr>`);

  const facts = [];
  if (uniques) facts.push(`${nf(uniques)} distinct visitors`);
  if (peakRow && visits(peakRow)) {
    const d = new Date(peakRow.date + 'T00:00:00Z');
    facts.push(`busiest day was ${d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })} ` +
               `(${nf(visits(peakRow))})`);
  }
  if (req && cached) facts.push(`${((cached / req) * 100).toFixed(0)}% served from cache`);
  if (bytes) facts.push(`${(bytes / 1e9).toFixed(2)} GB transferred`);
  if (facts.length) H.push(note(esc(facts.join(' · ')) + '.'));

  if (thisWeek.length) {
    H.push(h2('By day'));
    H.push(chart(thisWeek));
  }

  if (fb && fb.pages && Object.keys(fb.pages).length) {
    const total = Object.values(fb.pages).reduce((a, b) => a + b, 0) || 1;
    const rows = Object.entries(fb.pages).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([p, n]) => [
        `<a href="https://${SITE}/${esc(p)}" style="color:${ACCENT};text-decoration:none;">${esc(p)}</a>`,
        nf(n), `${((n / total) * 100).toFixed(0)}%`]);
    H.push(h2('Most read'));
    H.push(table(['Page', 'Views', 'Share'], rows, ['left', 'right', 'right']));
  }

  if (fb && fb.referrers && Object.keys(fb.referrers).length) {
    const ents = Object.entries(fb.referrers).sort((a, b) => b[1] - a[1]);
    const tot = ents.reduce((a, [, n]) => a + n, 0) || 1;
    let search = 0, social = 0, direct = 0;
    for (const [r, n] of ents) {
      if (r === 'direct') direct += n;
      else if (SEARCH.test(r)) search += n;
      else if (SOCIAL.test(r)) social += n;
    }
    H.push(h2('Where they came from'));
    H.push(table(['Source', 'Views', 'Share'],
      ents.slice(0, 10).map(([r, n]) => [esc(r), nf(n), `${((n / tot) * 100).toFixed(0)}%`]),
      ['left', 'right', 'right']));
    const reads = [];
    if (search) reads.push(`<b>${((search / tot) * 100).toFixed(0)}% arrived from search</b> — ` +
      `the part that grows without you doing anything`);
    if (social) reads.push(`${((social / tot) * 100).toFixed(0)}% from social or link aggregators — ` +
      `spiky by nature, so judge it over months`);
    if (direct === tot) reads.push('Everything was direct — either you, or people who already know the URL. ' +
      'No discovery happening yet.');
    if (reads.length) H.push(note(reads.join('<br>') + '.'));
  }

  if (!fb) {
    H.push(note('<b>Per-page and referrer detail is unavailable</b> — the on-site beacon ' +
      'needs the <code>FIREBASE_AUTH</code> secret. The totals above come from Cloudflare, ' +
      'which counts every request including visitors who never run JavaScript.'));
  }

  // Four-week context, once there is enough of it. A single comparison can be
  // a fluke; a direction held over a month usually is not.
  const weeks = [0, 1, 2, 3].map(i => sum(window_(hist, i), visits));
  if (weeks.filter(Boolean).length >= 3) {
    H.push(h2('Last four weeks'));
    H.push(table(['Week', 'Visits'],
      weeks.map((n, i) => [i === 0 ? 'This week' : `${i} week${i > 1 ? 's' : ''} ago`, nf(n)]),
      ['left', 'right']));
  }

  H.push(`<tr><td style="padding:18px 24px 26px;background:${CARD};border-top:1px solid ${RULE};` +
    `font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${MUTED};">` +
    `Generated by <code>.github/workflows/weekly-report.yml</code>. ` +
    `Aggregates only — no raw visitor records leave the collector.</td></tr>`);

  const html =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `</head><body style="margin:0;padding:0;background:${PAGE_BG};">` +
    `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" ` +
    `style="background:${PAGE_BG};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table width="600" cellpadding="0" cellspacing="0" border="0" role="presentation" ` +
    `style="width:600px;max-width:100%;background:${CARD};border:1px solid ${RULE};border-radius:8px;">` +
    H.join('') + `</table></td></tr></table></body></html>`;

  const text = [
    `${SITE} — week in review`,
    thisWeek.length ? `${thisWeek[0].date} to ${thisWeek[thisWeek.length - 1].date}` : '',
    '',
    `${nf(now)} visits — ${v.word}`,
    facts.length ? facts.join(' · ') + '.' : '',
    '',
    ...thisWeek.map(r => `  ${r.date}  ${String(nf(visits(r))).padStart(7)}`),
  ].filter(x => x !== null).join('\n');

  const subject = `[${SITE}] ${nf(now)} visits this week — ${v.word}`;
  emit({ send: 'true', subject, html, text });
  console.log(`send=true :: ${subject}`);
})();
