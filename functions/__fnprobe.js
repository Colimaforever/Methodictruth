/**
 * Does this Pages project compile Functions at all?
 *
 * A temporary diagnostic, and it exists because every other way of asking was
 * ambiguous. /feed returns 404, which has two causes needing opposite fixes:
 * the project compiles no Functions, or it does and /feed specifically is
 * broken. The obvious test -- probe functions/analyze.js, which has been here
 * for months -- gave a false positive: /analyze returns 200 because a static
 * analyze.html sits at that path, and Pages serves static assets ahead of
 * Functions. So that Function has never once run, and could not have.
 *
 * This path is deliberately one no static file can shadow: no analyze.html
 * equivalent, no implicit .html resolution, nothing in _redirects. A 200 here
 * means Functions work and /feed is my bug. A 404 means the project is not
 * building the functions directory, which is a dashboard fix.
 *
 * Answered on 22 Oct 2026: 404. This project compiles no Functions, so /feed
 * cannot work and the dispatch pages fall back to the public proxies.
 *
 * It stays rather than being deleted, because feed-check.js now reads it as
 * the signal for whether Functions run here at all -- which is worth knowing
 * on a schedule, since the dispatches depend on it. Removing the file would
 * make that check report "not compiled" forever, including after someone
 * fixes the project. It is two lines of output and no exposure: it takes no
 * input, reads nothing, and returns a constant.
 */

export async function onRequestGet() {
  return new Response('fn-ok', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
