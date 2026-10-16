import type { MiddlewareHandler } from 'hono';
import { publicBaseUrl } from '../lib/constants';
import type { AppEnv } from '../types';

// One URL per page for search engines (Search Console 2026-09-23: "alternative
// page with proper canonical tag" / "duplicate without user-selected canonical"
// — www.gankdat.com served every page as a second copy). Everything that is
// not the canonical origin is a permanent redirect to it:
//   www.<host>      → <host>       (same path + query)
//   http://<host>   → https://<host>
//   /stats/…/       → /stats/…     (Hono is strict about trailing slashes; a
//                                   404 there wastes crawl budget)
// API surfaces (/v1, /mcp, /x402) keep their paths byte-for-byte — only the
// host and scheme are corrected there, with 308 so a POST stays a POST.
// Runs before the assets fetcher so static pages are covered too.
const API_PREFIXES = ['/v1/', '/mcp', '/x402'];

export function canonicalHost(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const canonical = new URL(publicBaseUrl(c.env));
    const url = new URL(c.req.url);
    const isCanonicalHost = url.hostname === canonical.hostname;
    const isWww = url.hostname === `www.${canonical.hostname}`;
    if (!isCanonicalHost && !isWww) return next(); // preview / test hosts untouched

    let changed = false;
    if (isWww) {
      url.hostname = canonical.hostname;
      changed = true;
    }
    if (url.protocol !== canonical.protocol) {
      url.protocol = canonical.protocol;
      changed = true;
    }
    const isApi = API_PREFIXES.some((p) => url.pathname.startsWith(p));
    const readOnly = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (readOnly && !isApi && url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.replace(/\/+$/, '');
      changed = true;
    }
    if (!changed) return next();
    return c.redirect(url.toString(), readOnly ? 301 : 308);
  };
}

// Static files (public/) served through the assets binding. wrangler.jsonc sets
// run_worker_first so the Worker sees every request; this hands GET/HEAD to the
// assets pipeline (html_handling, _headers CSP, pretty-URL redirects all still
// apply) and falls through to the routes on a 404. It sits before secureHeaders
// on purpose: the per-page CSP in public/_headers must not be overwritten.
export function staticAssets(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const { pathname } = new URL(c.req.url);
    if (API_PREFIXES.some((p) => pathname.startsWith(p))) return next(); // no file lives there
    const assets = c.env.ASSETS as Fetcher | undefined; // absent when the pool has no assets
    if (!assets) return next();
    const res = await assets.fetch(c.req.raw);
    if (res.status === 404) return next();
    return res;
  };
}
