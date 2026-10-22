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

(async () => {
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
