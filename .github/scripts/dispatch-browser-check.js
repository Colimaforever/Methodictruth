// Load the LIVE dispatch pages in a real browser and report what a visitor
// gets.
//
// Everything else here probes feeds and proxies with fetch() from Node, which
// answers "is the service up" but not "does the page work". Those differ in
// ways that matter: CORS is enforced by browsers and by nothing else, the page
// may be served from a stale edge cache, and a proxy can answer a server
// politely while refusing a browser. Only a browser settles it.
//
// Run from a GitHub runner, which is outside the house network and outside
// Cloudflare -- the same vantage point as a visitor.

const { chromium } = require('playwright');

const ORIGIN = process.env.PROXY_BASE || 'https://methodictruth.com';
// Every page that renders feeds, not just the obvious two. index.html has an
// AI Dispatches panel and ai-evolution.html is a third full dispatch page;
// both were left broken for a day while the other two were being fixed,
// because nothing checked them. A list of pages is the kind of thing that goes
// stale quietly, so each entry names what proves that page worked.
const PAGES = [
  { file: 'index.html', ready: '#newsItems .news-item', empty: 'Feeds unavailable' },
  { file: 'ai-news.html', ready: '.an-card', empty: 'Could not reach any feed' },
  { file: 'music-news.html', ready: '.an-card', empty: 'Could not reach any feed' },
  { file: 'ai-evolution.html', ready: '.an-card', empty: 'Scrying the feeds' }
];
const PROXY_HOSTS = /cors\.lol|rss2json|allorigins|codetabs|dispatch\.json|\/feed\?/;

(async () => {
  const browser = await chromium.launch();
  let anyFailed = false;

  for (const { file: page_, ready, empty } of PAGES) {
    // The cache-buster matters: _headers allows the edge to serve stale HTML
    // for up to 24h while revalidating, so the plain URL can hand back an old
    // build and hide a deploy that worked.
    const url = `${ORIGIN}/${page_}?cb=${Date.now()}`;
    const page = await browser.newPage();
    const proxyCalls = [];
    const consoleErrors = [];

    page.on('response', r => {
      if (PROXY_HOSTS.test(r.url())) {
        proxyCalls.push(`${r.status()} ${r.url().slice(0, 95)}`);
      }
    });
    page.on('requestfailed', r => {
      if (PROXY_HOSTS.test(r.url())) {
        proxyCalls.push(`FAILED(${r.failure() ? r.failure().errorText : '?'}) ${r.url().slice(0, 80)}`);
      }
    });
    page.on('console', m => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
    });

    console.log(`\n=== ${page_} ===`);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      // The page's own budget is 14s per feed; give it room to settle.
      await page.waitForTimeout(20000);

      const cards = await page.locator(ready).count();
      const status = (await page.locator('#anStatus, #aeStatus, #newsUpdated').first()
        .textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
      const body = (await page.locator('#anFeed, #aeFeed, #newsItems').first()
        .textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
      // Reading the snapshot is what a fixed page does; still calling a public
      // proxy first means this page was missed.
      const usesSnapshot = await page.evaluate(() => document.documentElement.innerHTML.includes('SNAPSHOT_URL'));

      console.log(`  items rendered : ${cards}`);
      console.log(`  status line    : ${status.slice(0, 120)}`);
      console.log(`  reads snapshot : ${usesSnapshot ? 'yes' : 'NO -- this page was not migrated, or the build is stale'}`);
      if (!cards) console.log(`  body           : ${body.slice(0, 160)}`);
      if (!cards && body.includes(empty)) console.log(`  (showing its empty state: "${empty}")`);

      console.log(`  proxy requests the browser actually made:`);
      if (!proxyCalls.length) console.log('    (none -- the page never tried, which points at the page not the proxies)');
      // One line per distinct outcome; ten feeds produce ten near-identical rows.
      const seen = new Set();
      for (const c of proxyCalls) {
        const key = c.replace(/url=.*/, 'url=...').replace(/\?.*/, '?...');
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`    ${c}`);
      }
      if (consoleErrors.length) {
        console.log(`  console errors (first 5):`);
        [...new Set(consoleErrors)].slice(0, 5).forEach(e => console.log(`    ${e}`));
      }

      if (!cards) anyFailed = true;
    } catch (e) {
      console.log(`  could not load: ${e.message}`);
      anyFailed = true;
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log(anyFailed
    ? '\nFAILING: at least one dispatch page rendered no cards for a real browser.'
    : '\nBoth dispatch pages rendered cards in a real browser.');
  process.exit(anyFailed ? 1 : 0);
})();
