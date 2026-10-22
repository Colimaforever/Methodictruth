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
  } catch (e) {
    console.log(`--- could not reach ${ORIGIN}: ${e.message}\n`);
  } finally {
    clearTimeout(timer);
  }
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

(async () => {
  await identifyOrigin();
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

  const deadEverywhere = rows.filter(r => !r.direct.items && !r.viaProxy.items);
  const proxyWorks = rows.filter(r => r.viaProxy.items > 0);
  const proxy404 = rows.filter(r => r.viaProxy.code === '404');
  const proxyBlocked = rows.filter(r => r.direct.items > 0 && !r.viaProxy.items && r.viaProxy.code !== '404');

  console.log('\n--- verdict ---');
  if (proxy404.length === rows.length) {
    console.log('The /feed function is NOT deployed: every request returned 404.');
    console.log('The pages are falling through to the public proxies, exactly as before.');
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
  if (deadEverywhere.length) {
    console.log(`\n${deadEverywhere.length} feed URL(s) are dead by every route -- the URL itself is wrong:`);
    deadEverywhere.forEach(r => console.log(`  - ${r.page}: ${r.name}\n      ${r.url}`));

    console.log('\n--- hunting for replacements ---');
    for (const r of deadEverywhere) {
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
      `${deadEverywhere.length} dead URL(s), ${proxyBlocked.length} blocking our egress.\n`);
  }

  // A dead URL is a real defect in the pages, and so is a proxy that is not
  // deployed. A publisher that merely refuses our egress is worth reporting
  // but not worth failing over -- the fallbacks still cover it.
  process.exit(deadEverywhere.length || proxy404.length === rows.length ? 1 : 0);
})();
