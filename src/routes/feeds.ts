import { Hono } from 'hono';
import type { Context } from 'hono';
import { publicBaseUrl } from '../lib/constants';
import { failure } from '../lib/envelope';
import { isolateRateLimit } from '../metering/ratelimit';
import { queryD1Changes } from '../sources/d1store';
import type { ChangeRow } from '../sources/d1store';
import { getSource, hasChangeFeed, listSources } from '../sources/registry';
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
  const title = feedTitle(page);
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

/**
 * Every feed the Worker serves, in listing order: each register's feed, then one per facet value
 * the source lists (gankdat `change-feed-shelf-listing`, 2026-11-05: the day-30 read found no feed
 * reader had ever added one — Feedly's search was empty — so the feeds get a discovery page and an
 * OPML a reader imports in one step, instead of 62 URLs typed by hand).
 */
export function listFeeds(): FeedPage[] {
  const pages: FeedPage[] = [];
  for (const source of listSources().filter(hasChangeFeed)) {
    pages.push({ source });
    for (const spec of source.stats?.facets ?? []) {
      for (const { value, label } of spec.values) {
        pages.push({ source, facet: { spec, value, label } });
      }
    }
  }
  return pages;
}

export function feedTitle(page: FeedPage): string {
  return page.facet
    ? `${page.source.title} — ${page.facet.spec.segment} ${page.facet.value}: ${page.facet.label} — changes`
    : `${page.source.title} — changes`;
}

/** OPML 2.0 of every feed: one outline per register, its facet feeds nested; pure for tests. */
export function renderOpml(baseUrl: string, pages: FeedPage[], createdAt: string): string {
  const outlines: string[] = [];
  for (const page of pages.filter((p) => !p.facet)) {
    const facets = pages.filter((p) => p.facet && p.source.slug === page.source.slug);
    const children = facets
      .map(
        (p) =>
          `      <outline type="rss" text="${esc(feedTitle(p))}" title="${esc(feedTitle(p))}" xmlUrl="${esc(feedUrl(baseUrl, p))}" htmlUrl="${esc(statsUrl(baseUrl, p))}"/>`,
      )
      .join('\n');
    outlines.push(
      children
        ? `    <outline type="rss" text="${esc(feedTitle(page))}" title="${esc(feedTitle(page))}" xmlUrl="${esc(feedUrl(baseUrl, page))}" htmlUrl="${esc(statsUrl(baseUrl, page))}">\n${children}\n    </outline>`
        : `    <outline type="rss" text="${esc(feedTitle(page))}" title="${esc(feedTitle(page))}" xmlUrl="${esc(feedUrl(baseUrl, page))}" htmlUrl="${esc(statsUrl(baseUrl, page))}"/>`,
    );
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<opml version="2.0">
  <head>
    <title>gankdat change feeds — every UK and EU public register gankdat diffs daily</title>
    <dateCreated>${esc(createdAt)}</dateCreated>
    <ownerName>gankdat</ownerName>
    <docs>http://opml.org/spec2.opml</docs>
  </head>
  <body>
${outlines.join('\n')}
  </body>
</opml>
`;
}

const INDEX_STYLE = `
:root{--bg:#0A0A0A;--green:#00FF41;--fg:#E6E8EA;--muted:#8B9299;--mono:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--mono);padding:0 20px 60px}
main{max-width:820px;margin:0 auto}h1{font-size:1.5rem;letter-spacing:-.02em;margin:36px 0 6px}h1 b,a{color:var(--green)}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-top:34px}h2::before{content:"// ";color:var(--green)}
.muted{color:var(--muted);font-size:.85rem}ul{padding-left:20px}li{margin:4px 0}details{margin:6px 0}summary{cursor:pointer}`;

/** The feeds' own discovery page: every feed with its URL, the OPML, and how each shelf takes a feed. */
function indexHtml(baseUrl: string, pages: FeedPage[]): string {
  const registers = pages.filter((p) => !p.facet);
  const items = registers
    .map((page) => {
      const facets = pages.filter((p) => p.facet && p.source.slug === page.source.slug);
      const url = feedUrl(baseUrl, page);
      const facetList = facets.length
        ? `<details><summary class="muted">${facets.length} ${esc(facets[0]?.facet?.spec.segment ?? 'facet')} feeds</summary><ul>${facets
            .map(
              (p) =>
                `<li><a href="${esc(feedUrl(baseUrl, p))}">${esc(p.facet?.spec.segment ?? '')} ${esc(p.facet?.value ?? '')}: ${esc(p.facet?.label ?? '')}</a></li>`,
            )
            .join('')}</ul></details>`
        : '';
      return `<li><a href="${esc(url)}">${esc(page.source.title)}</a> <span class="muted">— <code>${esc(url)}</code> · <a href="${esc(statsUrl(baseUrl, page))}">statistics</a></span>${facetList}</li>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Change feeds (Atom) for ${registers.length} UK and EU public registers | gankdat</title>
<meta name="description" content="${registers.length} keyless Atom feeds (${pages.length} with the per-class feeds) of rows added, removed or changed in official UK and EU registers, diffed daily. Add one to any feed reader, Slack, Teams, Zapier, Make or n8n, or import them all with one OPML file.">
<link rel="canonical" href="${baseUrl}/feeds">
${registers.map((p) => `<link rel="alternate" type="application/atom+xml" title="${esc(feedTitle(p))}" href="${esc(feedUrl(baseUrl, p))}">`).join('\n')}
<style>${INDEX_STYLE}</style></head>
<body><main><p class="muted"><a href="/">gankdat</a> / feeds</p>
<h1>change <b>feeds</b></h1>
<p class="muted">Every register gankdat serves diffs itself each morning against the previous day's official file. These Atom feeds carry the last ${FEED_DAYS} days of rows added, removed or changed (≤ ${FEED_MAX_ENTRIES} entries, newest first), with no key and no sign-up. The JSON change feed behind them takes the register's own filters and 90 days of history with a <a href="/#key">free API key</a>.</p>
<h2>all feeds in one file</h2>
<p class="muted"><a href="/feeds/opml">/feeds/opml</a> — an OPML 2.0 file of all ${pages.length} feeds. Import it in Feedly (Settings → OPML), Inoreader (Preferences → Import), NetNewsWire, Reeder or any reader that takes OPML, and every register lands as a folder with its per-class feeds inside.</p>
<h2>feeds by register</h2>
<ul>
${items}
</ul>
<h2>where a feed goes</h2>
<ul class="muted">
<li>Feed readers (Feedly, Inoreader, NetNewsWire): paste the feed URL, or import the OPML above.</li>
<li>Slack: <code>/feed subscribe &lt;feed url&gt;</code> in any channel. Microsoft Teams: the RSS connector takes the same URL.</li>
<li>Zapier (RSS by Zapier → New Item in Feed), Make (RSS → Watch RSS feed items), n8n (RSS Feed Trigger) and Power Automate (RSS → When a feed item is published): the feed URL is the one setting; each new row is one trigger.</li>
<li>Agents: the MCP tool <code>get_changes</code> and <code>GET /v1/changes/&lt;slug&gt;</code> return the same rows as JSON with filters (<a href="/docs">docs</a>).</li>
</ul>
</main></body></html>`;
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
  .get('/', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.html(indexHtml(publicBaseUrl(c.env), listFeeds()));
  })
  .get('/opml', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    c.header('Content-Disposition', 'inline; filename="gankdat-feeds.opml"');
    return c.body(renderOpml(publicBaseUrl(c.env), listFeeds(), new Date().toUTCString()), 200, {
      'Content-Type': 'text/x-opml; charset=utf-8',
    });
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
