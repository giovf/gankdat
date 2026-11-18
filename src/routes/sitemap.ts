import type { MiddlewareHandler } from 'hono';
import { isLookup } from '../sources/lookup';
import { listSources } from '../sources/registry';
import { sourceStats } from '../sources/store';
import type { AppEnv } from '../types';

/**
 * `/sitemap.xml` without the stats pages that have nothing to show yet (gankdat
 * `stats-page-before-first-load`, 2026-11-18). The sitemap is a static file written the day a
 * register is added, so it advertised `/stats/uk-gender-pay-gap` and the statements page the
 * evening v0.31.0 deployed, hours before the first 05:15 wave: Amazonbot and AhrefsBot each met a
 * 503 there, on the slowest channel this product has (15 of 23 pages indexed). The Worker now
 * serves the file with the `<url>` entries of every not-yet-loaded register's stats page (and its
 * facet pages) left out; the list of such slugs is kept in KV for ten minutes, so a crawler's fetch
 * costs one read. A register is back in the sitemap within ten minutes of its first wave.
 */
const UNLOADED_KEY = 'sitemap:unloaded-stats';
const UNLOADED_TTL_S = 600;

/** Drop the `<url>` entries whose location is `/stats/<slug>` or beneath it, for the given slugs. */
export function filterSitemap(xml: string, unloadedSlugs: readonly string[]): string {
  if (unloadedSlugs.length === 0) return xml;
  const unloaded = new Set(unloadedSlugs);
  return xml.replace(
    /[ \t]*<url>\s*<loc>([^<]+)<\/loc>[\s\S]*?<\/url>[ \t]*\r?\n?/g,
    (entry, loc: string) => {
      const match = /^https?:\/\/[^/]+\/stats\/([^/?#]+)/.exec(loc.trim());
      return match && unloaded.has(match[1]!) ? '' : entry;
    },
  );
}

/** Registers whose stats page has nothing to serve: no blob, no snapshot, and no origin notice page. */
export async function unloadedStatsSlugs(env: CloudflareBindings): Promise<string[]> {
  const cached = await env.CACHE.get<string[]>(UNLOADED_KEY, 'json');
  if (Array.isArray(cached)) return cached;
  const slugs: string[] = [];
  for (const source of listSources()) {
    if (isLookup(source) || source.notice) continue; // both always answer a page
    if ((await sourceStats(env, source)) === null) slugs.push(source.slug);
  }
  await env.CACHE.put(UNLOADED_KEY, JSON.stringify(slugs), { expirationTtl: UNLOADED_TTL_S });
  return slugs;
}

/** Sits before `staticAssets()`: answers `/sitemap.xml` from the asset, filtered; anything else passes. */
export function sitemapWithoutUnloaded(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET' || new URL(c.req.url).pathname !== '/sitemap.xml') return next();
    const assets = c.env.ASSETS as Fetcher | undefined; // absent when the pool has no assets
    if (!assets) return next();
    const res = await assets.fetch(c.req.raw);
    if (res.status !== 200) return res;
    let slugs: string[];
    try {
      slugs = await unloadedStatsSlugs(c.env);
    } catch {
      return res; // the whole file beats no file
    }
    if (slugs.length === 0) return res;
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('Cache-Control', `public, max-age=${UNLOADED_TTL_S}`);
    return new Response(filterSitemap(await res.text(), slugs), { status: 200, headers });
  };
}
