// Fetch every dispatch feed in CI and write the result as a static file.
//
// The page cannot fetch a feed directly: browsers forbid it, and that is the
// entire reason the proxies existed. But CORS binds browsers only -- a GitHub
// runner can fetch all nineteen feeds without asking anyone's permission. So
// the fetching moves to where it is allowed, and what the page loads is an
// ordinary file on its own origin, which needs no CORS header, no third party,
// and nothing enabled in a dashboard.
//
// This became the plan after every alternative was measured and failed:
// rss2json now answers a bot challenge, allorigins and codetabs were 522,
// corsproxy.io wants a paid key, test.cors.workers.dev is banned for abuse,
// and cors.lol advertises Access-Control-Allow-Origin to a server while
// sending a browser nothing. Pages Functions would solve it properly, but this
// project does not compile them.
//
// The cost is honest and worth stating: the dispatches are now as fresh as the
// last run, not as fresh as the page load. For a news digest that is a fair
// trade for working at all, and /feed stays ahead of it in the chain, so the
// moment Functions are enabled the page goes live again by itself.

const fs = require('fs');

const PAGES = { 'ai-news.html': 'ai-dispatch.json', 'music-news.html': 'music-dispatch.json' };
const UA = 'MethodicTruthDispatchBuilder/1.0 (+https://methodictruth.com)';
const TIMEOUT = 20000;
const MAX_ITEMS = 15;          // enough to fill the page, small enough to stay cheap

function feedsFrom(file) {
  const src = fs.readFileSync(file, 'utf8');
  const block = src.match(/const FEEDS = \[([\s\S]*?)\n\s*\];/);
  if (!block) throw new Error('no FEEDS array found in ' + file);
  return block[1].split('\n')
    .map(line => line.match(/name: '([^']+)'[\s\S]*?url: '([^']+)'/))
    .filter(Boolean)
    .map(m => ({ name: m[1], url: m[2] }));
}

// The page parses feeds with DOMParser, which Node does not have. Rather than
// take a dependency for four fields, extract them directly -- but decode
// entities, because the browser path did that for free and "AT&amp;T" on a
// card would be a regression nobody would connect back to here.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+|#\d+);/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}
function uncdata(s) {
  return s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
}
function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(uncdata(m[1])).trim() : '';
}
function linkOf(block) {
  // Atom lists several <link> elements and rel="self" points at the feed, not
  // the article -- taking the first would link every card back to the feed.
  const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (alt) return decode(alt[1]);
  const text = tagText(block, 'link');
  if (text) return text;
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return href ? decode(href[1]) : '';
}

function parseItems(xml) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  return blocks.slice(0, MAX_ITEMS).map(b => ({
    title: tagText(b, 'title'),
    link: linkOf(b),
    pubDate: tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated'),
    // The page truncates and strips HTML itself; keep it bounded here so one
    // publisher's full-text feed cannot bloat the file for everyone.
    description: tagText(b, 'description').slice(0, 600) || tagText(b, 'summary').slice(0, 600)
  })).filter(it => it.title && it.link);
}

async function fetchFeed(url) {
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
    if (!r.ok) return { items: [], note: `HTTP ${r.status}` };
    return { items: parseItems(await r.text()) };
  } catch (e) {
    return { items: [], note: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  let total = 0;
  for (const [page, outFile] of Object.entries(PAGES)) {
    const feeds = feedsFrom(page);
    const out = { generated: new Date().toISOString(), feeds: {} };
    for (const feed of feeds) {
      const { items, note } = await fetchFeed(feed.url);
      out.feeds[feed.name] = items;
      total += items.length;
      console.log(`  ${items.length ? 'OK  ' : 'none'} ${String(items.length).padStart(3)} items  ${feed.name}${note ? `  (${note})` : ''}`);
    }

    // A run where everything failed must not overwrite a good file with an
    // empty one: a stale dispatch beats a blank page, and the previous file is
    // still perfectly readable.
    const got = Object.values(out.feeds).reduce((n, a) => n + a.length, 0);
    if (!got && fs.existsSync(outFile)) {
      console.log(`  refusing to overwrite ${outFile} with an empty snapshot`);
      continue;
    }
    fs.writeFileSync(outFile, JSON.stringify(out));
    console.log(`  wrote ${outFile} (${got} items, ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB)\n`);
  }
  console.log(`${total} items across both pages`);
  process.exit(total ? 0 : 1);
})();
