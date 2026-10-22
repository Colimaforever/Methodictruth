/**
 * Cloudflare Pages Function: RSS proxy for the dispatch pages.
 *
 * The AI and Sound Dispatch pages used to fetch their feeds through two free
 * public CORS proxies, api.rss2json.com and api.allorigins.win. That failed in
 * the way free shared infrastructure fails: fine for a while, then rate-limited
 * or simply down, and when it went the pages had nothing to show.
 *
 * This replaces them with the site's own origin. Three things follow from that:
 *
 *   - No CORS at all. Same origin, so the browser never has to be persuaded.
 *   - No rate limits that matter. The response is cached at Cloudflare's edge
 *     for the same twenty minutes the client caches it, so a feed is fetched
 *     roughly once per edge per twenty minutes no matter how many people are
 *     reading. Previously every visitor's browser hit the proxy ten times.
 *   - No third party sees who is reading what.
 *
 * The allowlist is the load-bearing part. A proxy that fetches whatever URL it
 * is handed is an open relay — someone else's bandwidth and your domain's
 * reputation — and on Cloudflare it can also reach addresses a public client
 * cannot. Only the hosts the two pages actually read are permitted.
 */

const ALLOWED_HOSTS = new Set([
  // AI Dispatches
  'rss.arxiv.org',
  'arxiv.org',
  'huggingface.co',
  'blog.google',
  'venturebeat.com',
  'www.technologyreview.com',
  'spectrum.ieee.org',
  'www.theverge.com',
  'www.wired.com',
  'news.mit.edu',
  // Sound Dispatches
  'www.synthtopia.com',
  'bedroomproducersblog.com',
  'www.gearnews.com',
  'www.attackmagazine.com',
  'cdm.link',
  'musictech.com',
  'www.musicradar.com',
]);

// Matches the client's own cache window, so the two do not fight: the browser
// asks at most every twenty minutes and the edge answers most of those from
// cache without touching the publisher at all.
const EDGE_TTL = 1200;

// A publisher that stops responding should not hold a Worker open. Cloudflare
// would eventually cut it, but a clean error the page can render beats a
// connection that dies somewhere the client cannot see.
const UPSTREAM_TIMEOUT_MS = 10000;

function deny(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestGet(context) {
  const target = new URL(context.request.url).searchParams.get('url');
  if (!target) return deny('url parameter required', 400);

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return deny('url is not a URL', 400);
  }

  // http:// is accepted because a couple of the feeds are still published that
  // way, but it is upgraded rather than passed through: this hop runs on
  // Cloudflare, so there is no reason for it to be the insecure one.
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  if (parsed.protocol !== 'https:') return deny('only http(s) is proxied', 400);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return deny('host not on the feed allowlist', 403);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(parsed.toString(), {
      signal: ctl.signal,
      // Some publishers return 403 to a bare fetch with no user agent.
      headers: {
        'User-Agent': 'MethodicTruthFeedReader/1.0 (+https://methodictruth.com)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
      cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
    });

    if (!upstream.ok) return deny(`upstream ${upstream.status}`, 502);

    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: {
        // Publishers mislabel feeds often enough that trusting their
        // Content-Type gets XML parsed as HTML. The pages ask for XML and know
        // what they requested, so say so.
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': `public, max-age=300, s-maxage=${EDGE_TTL}, stale-while-revalidate=86400`,
        'Access-Control-Allow-Origin': '*',
        'X-Feed-Host': parsed.hostname,
      },
    });
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return deny(aborted ? 'upstream timed out' : 'upstream unreachable', 504);
  } finally {
    clearTimeout(timer);
  }
}
