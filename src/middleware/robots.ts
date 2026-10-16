import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

// Search Console 2026-10-15 ("Blocked due to unauthorised request (401)"): Googlebot
// follows the /v1/data and /mcp links from the docs and llms.txt into the keyless walls
// — requireApiKey's 401, the preview / quota / x402 402s — and reports each as a page it
// could not index. robots.txt deliberately keeps those paths crawlable (agents and
// directory crawlers read the 401/402 bodies to find the sign-up and payment hints), so
// instead every 401 and 402 the Worker sends carries `X-Robots-Tag: noindex`: crawlers
// may fetch the wall, search engines never list it. Runs after the assets fetcher
// (static files never answer 401/402) and sees the response of every route, including
// the ones app.onError produces from an HTTPException.
export const ROBOTS_HEADER = 'X-Robots-Tag';
export const NOINDEX_STATUSES: ReadonlySet<number> = new Set([401, 402]);

export function noindexWalls(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (!NOINDEX_STATUSES.has(c.res.status)) return;
    if (c.res.headers.has(ROBOTS_HEADER)) return; // a route that set its own wins
    try {
      c.res.headers.set(ROBOTS_HEADER, 'noindex');
    } catch {
      // A Response that came back from fetch() has immutable headers: rebuild it.
      const copy = new Response(c.res.body, c.res);
      copy.headers.set(ROBOTS_HEADER, 'noindex');
      c.res = copy;
    }
  };
}
