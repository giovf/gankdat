import { Hono } from 'hono';
import type { Context } from 'hono';
import { publicBaseUrl } from '../lib/constants';
import { failure } from '../lib/envelope';
import { isolateRateLimit } from '../metering/ratelimit';
import { queryD1Changes } from '../sources/d1store';
import type { ChangeRow } from '../sources/d1store';
import { getSource, hasChangeFeed } from '../sources/registry';
import type { DataSource, StatsFacet } from '../sources/types';
import type { AppEnv } from '../types';

// Keyless Atom feeds of the change feeds (queue `change-feed-rss`, 2026-10-05): the
// register's last 7 days of added / removed / changed rows as `/feeds/<slug>.xml`, and one
// per facet value as `/feeds/<slug>/<segment>/<value>.xml` — the same filter the facet
// stats page sells. Feed readers (Feedly, Inoreader), the Slack and Teams RSS apps and the
// RSS triggers of Zapier, Make, n8n and Power Automate reach the product without a key or
// a connector; every entry links the stats page and the key sign-up, so the key is the
// upgrade (filters, history, JSON). Rendered from D1 at most once an hour per feed (KV
// cache) and rate limited per IP like /stats; an Analytics Engine `rest_feed` point (UA +
// slug) is the shelf reading in the Daily numbers row.

/** Window and size of a feed: a week of changes, newest first, at most this many entries. */
export const FEED_DAYS = 7;
export const FEED_MAX_ENTRIES = 50;
/** One D1 read per feed per hour at most; the waves finish by 06:20 UTC, so readers see the day's diff by 07:20. */
export const FEED_CACHE_SECONDS = 3600;

const feedKey = (slug: string, segment?: string, value?: string): string =>
  segment !== undefined && value !== undefined
    ? `feed:${slug}/${segment}/${value}`
    : `feed:${slug}`;

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * A dataset-agnostic one-line title for a record (isolation rule: nothing per source):
 * the first two short string fields that are not URLs or ids, else the record id.
 */
export function entryTitle(row: ChangeRow): string {
  const parts: string[] = [];
  if (isRecord(row.record)) {
    for (const [key, value] of Object.entries(row.record)) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 80) continue;
      if (/^https?:\/\//.test(value) || /(^|_)(id|url|uri)$/i.test(key)) continue;
      parts.push(value);
      if (parts.length === 2) break;
    }
  }
  return `${row.change}: ${parts.length ? parts.join(' — ') : row.record_id}`;
}

/** Plain-text summary of the record: `key: value` lines for scalar fields, first 12. */
export function entrySummary(row: ChangeRow): string {
  if (!isRecord(row.record)) return String(row.record_id);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(row.record)) {
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') continue;
    lines.push(`${key}: ${String(value).slice(0, 200)}`);
    if (lines.length === 12) break;
  }
  return lines.join('\n');
}

export interface FeedPage {
  source: DataSource;
  facet?: { spec: StatsFacet; value: string; label: string };
}

export function feedUrl(baseUrl: string, page: FeedPage): string {
  return page.facet
    ? `${baseUrl}/feeds/${page.source.slug}/${page.facet.spec.segment}/${encodeURIComponent(page.facet.value)}.xml`
    : `${baseUrl}/feeds/${page.source.slug}.xml`;
}

function statsUrl(baseUrl: string, page: FeedPage): string {
  return page.facet
    ? `${baseUrl}/stats/${page.source.slug}/${page.facet.spec.segment}/${encodeURIComponent(page.facet.value)}`
    : `${baseUrl}/stats/${page.source.slug}`;
}

/** Atom 1.0 document for the rows; pure so it can be tested without D1. */
export function renderAtom(
  baseUrl: string,
  page: FeedPage,
  rows: ChangeRow[],
  generatedAt: string,
): string {
  const self = feedUrl(baseUrl, page);
  const stats = statsUrl(baseUrl, page);
  const title = page.facet
    ? `${page.source.title} — ${page.facet.spec.segment} ${page.facet.value}: ${page.facet.label} — changes`
    : `${page.source.title} — changes`;
  const updated = rows[0]?.changed_at ?? generatedAt;
  const host = new URL(baseUrl).host;
  const entries = rows
    .map((row) => {
      const id = `tag:${host},2026:${page.source.slug}/${row.changed_at}/${row.change}/${row.record_id}`;
      const summary = `${entrySummary(row)}\n\nStatistics and filters: ${stats}\nJSON change feed (free API key, ${baseUrl}/#key): ${baseUrl}/v1/changes/${page.source.slug}`;
      return `<entry>
<id>${esc(id)}</id>
<title>${esc(entryTitle(row))}</title>
<link rel="alternate" href="${esc(stats)}"/>
<updated>${esc(row.changed_at)}</updated>
<category term="${esc(row.change)}"/>
<content type="text">${esc(summary)}</content>
</entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<id>${esc(self)}</id>
<title>${esc(title)}</title>
<subtitle>${esc(`Rows added, removed or changed in the last ${FEED_DAYS} days, from the official register, diffed daily by gankdat. Filters, history and JSON need a free API key.`)}</subtitle>
<link rel="self" type="application/atom+xml" href="${esc(self)}"/>
<link rel="alternate" type="text/html" href="${esc(stats)}"/>
<updated>${esc(updated)}</updated>
<author><name>gankdat</name><uri>${esc(baseUrl)}</uri></author>
<generator uri="${esc(baseUrl)}">gankdat</generator>
${entries}
</feed>
`;
}

function resolve(
  slug: string,
  segment?: string,
  value?: string,
): { page: FeedPage } | { error: string } {
  const source = getSource(slug);
  if (!source || !hasChangeFeed(source)) {
    return { error: 'No change feed for this dataset (register datasets only)' };
  }
  if (segment === undefined || value === undefined) return { page: { source } };
  const spec = source.stats?.facets?.find((f) => f.segment === segment);
  const listed = spec?.values.find((v) => v.value === value);
  if (!spec || !listed) return { error: 'Unknown feed' };
  return { page: { source, facet: { spec, value, label: listed.label } } };
}

/** Builds (or serves from KV) one feed; one D1 read per feed per cache window. */
async function serveFeed(
  c: Context<AppEnv>,
  slug: string,
  segment?: string,
  value?: string,
): Promise<Response> {
  const resolved = resolve(slug, segment, value);
  if ('error' in resolved) return c.json(failure('not_found', resolved.error), 404);
  const { page } = resolved;
  const key = feedKey(slug, segment, value);
  let xml = await c.env.CACHE.get(key, 'text').catch(() => null);
  let hit = true;
  if (!xml) {
    hit = false;
    const since = new Date(Date.now() - FEED_DAYS * 86_400_000).toISOString();
    const filters = page.facet ? { [page.facet.spec.field]: page.facet.value } : {};
    const { rows } = await queryD1Changes(c.env, page.source, {
      since,
      page: 1,
      per_page: FEED_MAX_ENTRIES,
      filters,
    });
    xml = renderAtom(publicBaseUrl(c.env), page, rows, new Date().toISOString());
    await c.env.CACHE.put(key, xml, { expirationTtl: FEED_CACHE_SECONDS }).catch(() => undefined);
  }
  try {
    c.env.TRAFFIC.writeDataPoint({
      blobs: [
        'rest_feed',
        c.req.header('User-Agent') ?? '',
        c.req.path,
        hit ? 'hit' : 'miss',
        slug,
      ],
      doubles: [1],
      indexes: ['rest_feed'],
    });
  } catch {
    // Analytics never fails a feed.
  }
  c.header('Cache-Control', `public, max-age=${FEED_CACHE_SECONDS}`);
  return c.body(xml, 200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
}

const stripXml = (name: string): string | null =>
  name.endsWith('.xml') ? name.slice(0, -'.xml'.length) : null;

export const feedsRoutes = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const retryAfter = isolateRateLimit(`feeds:${ip}`, 120, 60);
    if (retryAfter > 0) {
      c.header('Retry-After', String(retryAfter));
      return c.json(failure('rate_limited', 'Rate limit exceeded; retry later'), 429);
    }
    return next();
  })
  .get('/:file', (c) => {
    const slug = stripXml(c.req.param('file'));
    if (slug === null) return c.json(failure('not_found', 'Unknown feed'), 404);
    return serveFeed(c, slug);
  })
  .get('/:source/:segment/:file', (c) => {
    const value = stripXml(c.req.param('file'));
    if (value === null) return c.json(failure('not_found', 'Unknown feed'), 404);
    return serveFeed(c, c.req.param('source'), c.req.param('segment'), value);
  });
