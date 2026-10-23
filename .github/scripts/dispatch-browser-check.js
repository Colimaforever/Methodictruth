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
const PAGES = ['ai-news.html', 'music-news.html'];
const PROXY_HOSTS = /cors\.lol|rss2json|allorigins|codetabs|\/feed\?/;

(async () => {
  const browser = await chromium.launch();
  let anyFailed = false;

  for (const page_ of PAGES) {
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

      const cards = await page.locator('.an-card').count();
      const status = (await page.locator('#anStatus').textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
      const body = (await page.locator('#anFeed').textContent().catch(() => '')).replace(/\s+/g, ' ').trim();
      const hasCorsLol = await page.evaluate(() => document.documentElement.innerHTML.includes('fetchViaCorsLol'));

      console.log(`  cards rendered : ${cards}`);
      console.log(`  status line    : ${status.slice(0, 120)}`);
      console.log(`  deployed build : ${hasCorsLol ? 'current (has cors.lol route)' : 'STALE -- no cors.lol route in the served HTML'}`);
      if (!cards) console.log(`  body           : ${body.slice(0, 160)}`);

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
