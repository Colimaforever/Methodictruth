// Which dispatch feeds are actually alive, and does our own proxy serve them?
//
// Two questions, and they need different answers. A feed can be dead at the
// publisher (moved, retired, or now behind a bot wall), or alive at the
// publisher but unreachable through /feed -- some sites answer a browser and
// refuse datacenter egress. The dispatch pages cannot tell those apart; they
// just show one fewer source and say nothing. music-news read two arXiv feeds
// from a path that had stopped serving for months, and nothing reported it.
//
// This runs on a GitHub runner because that is outside both the house network
// and Cloudflare, which is the only vantage point that sees what a visitor
// sees. Same reasoning as uptime.yml.
//
// The feed list is parsed out of the pages themselves rather than copied here.
// A second copy of a list is a copy that goes stale, and the whole point is to
// catch things going stale.

const fs = require('fs');

const PAGES = ['ai-news.html', 'music-news.html'];
const ORIGIN = process.env.PROXY_BASE || 'https://methodictruth.com';
const UA = 'MethodicTruthFeedCheck/1.0 (+https://methodictruth.com)';
const TIMEOUT = 20000;

// When a publisher moves its feed there is no redirect and no notice, so the
// only way to find the new address is to try the handful of places a feed
// conventionally lives. Probed only for feeds that actually failed.
const CANDIDATES = {
  'www.musicradar.com': [
    'https://www.musicradar.com/feeds/all',
    'https://www.musicradar.com/feed',
    'https://www.musicradar.com/rss',
    'https://www.musicradar.com/feeds.xml',
    'https://www.musicradar.com/feeds/articletype/news'
  ],
  'www.soundonsound.com': [
    'https://www.soundonsound.com/rss/news',
    'https://www.soundonsound.com/feeds/news',
    'https://www.soundonsound.com/feed',
    'https://www.soundonsound.com/rss',
    'https://www.soundonsound.com/news/feed'
  ],
  'venturebeat.com': [
    'https://venturebeat.com/feed/',
    'https://venturebeat.com/category/ai/feed/',
    'https://venturebeat.com/rss'
  ]
};

function feedsFrom(file) {
  const src = fs.readFileSync(file, 'utf8');
  const block = src.match(/const FEEDS = \[([\s\S]*?)\n\s*\];/);
  if (!block) throw new Error('no FEEDS array found in ' + file);
  return block[1].split('\n')
    .map(line => line.match(/name: '([^']+)'[\s\S]*?url: '([^']+)'/))
    .filter(Boolean)
    .map(m => ({ page: file, name: m[1], url: m[2] }));
}

async function probe(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
      }
    });
    const body = await r.text();
    // Counting tags is cruder than parsing, but it needs no dependency and the
    // question is only "did a feed with entries come back".
    const items = (body.match(/<item[\s>]|<entry[\s>]/g) || []).length;
    return { code: String(r.status), items, bytes: body.length };
  } catch (e) {
    return { code: e.name === 'AbortError' ? 'timeout' : 'neterr', items: 0, bytes: 0, note: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Whenever /feed 404s, the next question is always what is actually serving
// this domain -- a Pages Function cannot run on a host that has no Functions.
// The `_headers` rules are the tell: Cloudflare Pages applies them, GitHub
// Pages ignores the file entirely. So the response to a plain page answers
// which of the two we are talking to, without needing dashboard access.
async function identifyOrigin() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${ORIGIN}/index.html`, { signal: ctl.signal, headers: { 'User-Agent': UA } });
    const h = (k) => r.headers.get(k) || '-';
    console.log('--- what is serving this domain ---');
    console.log(`  status                 ${r.status}`);
    console.log(`  server                 ${h('server')}`);
    console.log(`  cf-ray                 ${h('cf-ray')}`);
    console.log(`  x-github-request-id    ${h('x-github-request-id')}`);
    console.log(`  cache-control          ${h('cache-control')}`);
    console.log(`  x-content-type-options ${h('x-content-type-options')}`);
    const headersApplied = /s-maxage=300/.test(h('cache-control')) || h('x-content-type-options') === 'nosniff';
    console.log(headersApplied
      ? '  => _headers IS applied, so Cloudflare Pages is serving. /feed failing is a project setting.'
      : '  => _headers is NOT applied. This is very likely GitHub Pages, which cannot run Functions');
    if (!headersApplied) console.log('     at all -- and which also silently ignores _headers and _redirects.');

    // Does this project compile Functions at all? The obvious test -- probe
    // functions/analyze.js, which has been here for months -- gives a FALSE
    // POSITIVE: /analyze returns 200 because a static analyze.html sits at
    // that path and Pages serves assets ahead of Functions. So that Function
    // has never run and could not have.
    //
    // /__fnprobe is a path no static file can shadow, which makes its answer
    // unambiguous.
    const fnProbe = await fetch(`${ORIGIN}/__fnprobe`, { headers: { 'User-Agent': UA } })
      .then(async r => ({ code: String(r.status), body: (await r.text()).slice(0, 40), type: r.headers.get('content-type') || '-' }))
      .catch(e => ({ code: 'neterr', body: e.message, type: '-' }));
    console.log(`  /__fnprobe -> ${fnProbe.code} ${fnProbe.type} ${JSON.stringify(fnProbe.body)}`);
    console.log(fnProbe.body === 'fn-ok'
      ? '  => Functions DO compile here, so /feed alone is at fault -- my bug.'
      : '  => Functions are NOT compiled on this project. A dashboard fix, not a code fix.');
    console.log('');
    return { functionsCompile: fnProbe.body === 'fn-ok' };
  } catch (e) {
    console.log(`--- could not reach ${ORIGIN}: ${e.message}\n`);
    return { functionsCompile: false, unreachable: true };
  } finally {
    clearTimeout(timer);
  }
}

// Why a feed came back empty decides whether anyone should be told. These are
// genuinely different conditions and only one of them is anybody's to fix:
//
//   blocked  403/429 -- the publisher refuses datacenter egress. Permanent,
//                       works fine from a browser, nothing to do about it.
//   flaky    timeout, network error, or any 5xx -- the publisher's own
//                       infrastructure is having a moment. Synthtopia served
//                       15 items in the morning and 522 by evening with the
//                       URL unchanged, so treating 5xx as a dead URL means
//                       emailing about someone else's outage.
//   gone     404/410, or 200 carrying no items -- the URL is wrong and the
//                       page needs editing. This one is worth an email.
const BLOCKING_CODES = new Set(['403', '429']);
function classify(row) {
  if (row.direct.items || row.viaProxy.items) return 'ok';
  if (BLOCKING_CODES.has(row.direct.code)) return 'blocked';
  if (row.direct.code === 'timeout' || row.direct.code === 'neterr') return 'flaky';
  if (/^5\d\d$/.test(row.direct.code)) return 'flaky';
  return 'gone';
}

// A 404 from /feed has two very different causes, and they need opposite
// responses: either the deploy never happened (wait, or fix the build), or it
// happened and Functions are not being compiled (fix the project). Comparing
// the served page against the committed one separates them, and keeps being
// useful afterwards -- a Pages build that fails leaves the previous deployment
// serving, which looks exactly like a deploy that worked.
async function checkDeployFreshness() {
  console.log('--- is the deployed site current? ---');
  for (const page of PAGES) {
    const local = fs.readFileSync(page, 'utf8');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(`${ORIGIN}/${page}`, { signal: ctl.signal, headers: { 'User-Agent': UA } });
      const served = await r.text();
      const same = served === local;
      console.log(`  ${page}: ${r.status}, ${same ? 'identical to HEAD' : 'DIFFERS from HEAD'}` +
        ` (served ${served.length}B vs committed ${local.length}B)`);
      if (!same) {
        // The marker is whatever makes this commit distinguishable. If the
        // served copy lacks it, the deploy is behind.
        console.log(`    contains fetchViaOrigin: ${served.includes('fetchViaOrigin')}` +
          ` -- if false, this commit is not deployed yet`);
      }
    } catch (e) {
      console.log(`  ${page}: could not fetch (${e.message})`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log('');
}

// Until /feed exists, the pages depend entirely on two free public proxies, so
// their health IS the dispatches' health. Worth probing on the same schedule:
// when both are refusing, the pages show nothing no matter how healthy the
// publishers are, and that is the difference between "a feed moved" and "the
// whole page is blank" -- which look identical from a browser.
const FALLBACKS = [
  ['rss2json    ', u => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(u)}`],
  ['allorigins  ', u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`],
  // Candidates. Both of the above died on the same day for unrelated reasons,
  // which is an argument for more routes rather than a better one.
  ['codetabs    ', u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`],
  ['corsproxy.io', u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`],
  ['cors.lol    ', u => `https://api.cors.lol/?url=${encodeURIComponent(u)}`],
  ['whateverorig', u => `https://whateverorigin.org/get?url=${encodeURIComponent(u)}`],
  ['cors.workers', u => `https://test.cors.workers.dev/?${u}`]
];
async function checkFallbackProxies() {
  const sample = 'https://cdm.link/feed/';
  console.log('--- public proxies: alive, and usable from a browser? ---');
  console.log('    (CORS matters as much as the body -- no ACAO header means a page cannot read it)');
  for (const [name, build] of FALLBACKS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      // Origin: is what a browser would send, and is what decides whether the
      // answer carries a usable Access-Control-Allow-Origin.
      const r = await fetch(build(sample), {
        signal: ctl.signal,
        headers: { 'User-Agent': UA, 'Origin': 'https://methodictruth.com' }
      });
      const body = await r.text();
      const items = (body.match(/<item[\s>]|<entry[\s>]|\\u003citem|"title"/g) || []).length;
      const acao = r.headers.get('access-control-allow-origin') || 'NONE';
      console.log(`  ${name} -> ${r.status} ${String(items).padStart(3)} items  ACAO=${acao}`);
      if (!items) console.log(`    body: ${JSON.stringify(body.slice(0, 120))}`);
    } catch (e) {
      console.log(`  ${name} -> unreachable (${e.name === 'AbortError' ? 'timeout' : e.message})`);
    } finally {
      clearTimeout(timer);
    }
  }
  console.log('');
}

(async () => {
  const { functionsCompile } = await identifyOrigin();
  await checkFallbackProxies();
  await checkDeployFreshness();

  const feeds = PAGES.flatMap(feedsFrom);
  console.log(`Checking ${feeds.length} feeds directly and through ${ORIGIN}/feed\n`);

  const rows = [];
  for (const feed of feeds) {
    const direct = await probe(feed.url);
    const viaProxy = await probe(`${ORIGIN}/feed?url=${encodeURIComponent(feed.url)}`);
    rows.push({ ...feed, direct, viaProxy });
    console.log(
      `${(direct.items ? 'OK  ' : 'DEAD').padEnd(5)} direct ${direct.code.padEnd(7)} items=${String(direct.items).padEnd(4)}` +
      ` | proxy ${viaProxy.code.padEnd(7)} items=${String(viaProxy.items).padEnd(4)} | ${feed.name}`
    );
    if (direct.note) console.log(`        direct: ${direct.note}`);
    if (viaProxy.note) console.log(`        proxy:  ${viaProxy.note}`);
  }

  rows.forEach(r => { r.state = classify(r); });
  const gone = rows.filter(r => r.state === 'gone');
  const blocked = rows.filter(r => r.state === 'blocked');
  const flaky = rows.filter(r => r.state === 'flaky');
  const proxyWorks = rows.filter(r => r.viaProxy.items > 0);
  const proxy404 = rows.filter(r => r.viaProxy.code === '404');
  const proxyBlocked = rows.filter(r => r.direct.items > 0 && !r.viaProxy.items && r.viaProxy.code !== '404');

  console.log('\n--- verdict ---');
  if (proxy404.length === rows.length) {
    console.log('The /feed function is NOT deployed: every request returned 404.');
    console.log(functionsCompile
      ? 'Functions DO compile here, so /feed itself is broken. That is actionable.'
      : 'Expected: this project compiles no Functions at all, so there is nothing for');
    if (!functionsCompile) console.log('/feed to be. The pages fall back to the public proxies until that is changed.');
  } else if (proxyWorks.length) {
    console.log(`The /feed function is live and served ${proxyWorks.length}/${rows.length} feeds.`);
  } else {
    console.log('The /feed function answered, but served no feed successfully.');
  }
  if (proxyBlocked.length) {
    console.log(`\n${proxyBlocked.length} feed(s) answer a direct request but not ours -- these publishers`);
    console.log('refuse Cloudflare/datacenter egress, and need a different route:');
    proxyBlocked.forEach(r => console.log(`  - ${r.name} (proxy said ${r.viaProxy.code})`));
  }
  if (blocked.length) {
    console.log(`\n${blocked.length} feed(s) refuse datacenter egress (${blocked.map(r => r.direct.code).join(', ')}).`);
    console.log('Expected and permanent -- they serve a residential browser fine:');
    blocked.forEach(r => console.log(`  - ${r.name}`));
  }
  if (flaky.length) {
    console.log(`\n${flaky.length} feed(s) timed out or errored this run. Transient, not reported as broken:`);
    flaky.forEach(r => console.log(`  - ${r.name} (${r.direct.code})`));
  }
  if (gone.length) {
    console.log(`\n${gone.length} feed URL(s) are dead by every route -- the URL itself is wrong:`);
    gone.forEach(r => console.log(`  - ${r.page}: ${r.name}\n      ${r.url}`));

    console.log('\n--- hunting for replacements ---');
    for (const r of gone) {
      const host = new URL(r.url).hostname;
      const list = (CANDIDATES[host] || []).filter(u => u !== r.url);
      if (!list.length) { console.log(`${r.name}: no candidates listed to try`); continue; }
      console.log(`${r.name}:`);
      for (const candidate of list) {
        const got = await probe(candidate);
        console.log(`  ${(got.items ? 'WORKS' : 'no   ').padEnd(6)} ${got.code.padEnd(7)} items=${String(got.items).padEnd(4)} ${candidate}`);
      }
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['| Feed | Page | Direct | Via /feed |', '| --- | --- | --- | --- |']
      .concat(rows.map(r =>
        `| ${r.name} | ${r.page.replace('.html', '')} | ${r.direct.code} (${r.direct.items}) | ${r.viaProxy.code} (${r.viaProxy.items}) |`))
      .join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `## Feed check\n\n${md}\n\nProxy served ${proxyWorks.length}/${rows.length}. ` +
      `${gone.length} dead URL(s), ${blocked.length} refusing datacenter egress.\n`);
  }

  // Fail only for something a person should act on, because a check that cries
  // wolf gets filtered and then the real failure is missed too. uptime.yml in
  // this repo already says as much, and mails on state change only.
  //
  // Not actionable: a publisher blocking datacenter IPs, a transient timeout,
  // or /feed 404ing on a project that compiles no Functions -- that last one is
  // a known state, and emailing about it weekly says nothing new.
  const actionable = [];
  if (gone.length) actionable.push(`${gone.length} feed URL(s) need repointing`);
  if (functionsCompile && !proxyWorks.length) actionable.push('/feed exists but serves no feed');

  if (actionable.length) {
    console.log(`\nFAILING: ${actionable.join('; ')}`);
    process.exit(1);
  }
  console.log('\nNothing actionable. ' +
    `${rows.length - gone.length - blocked.length - flaky.length}/${rows.length} feeds healthy` +
    `${blocked.length ? `, ${blocked.length} blocking datacenter egress (expected)` : ''}` +
    `${functionsCompile ? '' : ', /feed still awaiting Functions on the Pages project'}.`);
})();
