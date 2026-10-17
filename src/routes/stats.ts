import { Hono } from 'hono';
import { publicBaseUrl } from '../lib/constants';
import { failure } from '../lib/envelope';
import type { FacetPage, FacetStats, MonthlyTrend, SourceStats, StatsGroup } from '../lib/stats';
import { isolateRateLimit } from '../metering/ratelimit';
import { isLookup } from '../sources/lookup';
import { getSource, hasChangeFeed, listSources } from '../sources/registry';
import { sourceStats } from '../sources/store';
import type { DataSource } from '../sources/types';
import type { AppEnv } from '../types';

// Public per-source statistics pages (cite-bait, task 34): computed monthly
// numbers with methodology and machine-legible tables + schema.org Dataset
// JSON-LD, so search snippets and LLM retrieval can lift facts with
// attribution. Registry-driven — a new source gets its page automatically;
// its StatsSpec (in the source file, isolation rule) enriches it. No auth, no
// metering: the page IS the marketing. In-isolate rate limit only (KV-free).

const esc = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const STYLE = `
:root{--bg:#0A0A0A;--panel:#111315;--green:#00FF41;--border:#2A2E33;--fg:#E6E8EA;--muted:#8B9299;
--mono:"JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--mono);padding:0 20px 60px}
main{max-width:820px;margin:0 auto}h1{font-size:1.5rem;letter-spacing:-.02em;margin:36px 0 6px}
h1 b,a{color:var(--green)}h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);margin-top:34px}
h2::before{content:"// ";color:var(--green)}table{border-collapse:collapse;width:100%;margin-top:10px;background:var(--panel)}
td,th{border:1px solid var(--border);padding:6px 12px;text-align:left;font-size:.85rem}th{color:var(--muted);font-weight:600}
td:last-child,th:last-child{text-align:right}.muted{color:var(--muted);font-size:.85rem}
.cta{border:1px solid var(--green);padding:14px 18px;margin-top:38px}.cta a{margin-right:18px}`;

function tableHtml(header: [string, string], rows: [string, number][]): string {
  const body = rows
    .map(
      ([label, count]) =>
        `<tr><td>${esc(label)}</td><td>${count.toLocaleString('en-GB')}</td></tr>`,
    )
    .join('');
  return `<table><thead><tr><th>${header[0]}</th><th>${header[1]}</th></tr></thead><tbody>${body}</tbody></table>`;
}

function changesHtml(source: DataSource, stats: SourceStats): string {
  if (!hasChangeFeed(source)) return '';
  const days = stats.changes ?? [];
  const since = days.at(-1)?.date ?? new Date().toISOString().slice(0, 10);
  const body =
    days.length === 0
      ? '<p class="muted">No diff yet — the feed starts with the dataset\'s second daily refresh.</p>'
      : `<table><thead><tr><th>refresh day</th><th>added</th><th>removed</th><th>changed</th></tr></thead><tbody>${days
          .map(
            (d) =>
              `<tr><td>${esc(d.date)}</td><td>${d.added.toLocaleString('en-GB')}</td><td>${d.removed.toLocaleString('en-GB')}</td><td>${d.changed.toLocaleString('en-GB')}</td></tr>`,
          )
          .join('')}</tbody></table>`;
  const totals = days.reduce(
    (acc, d) => ({
      added: acc.added + d.added,
      removed: acc.removed + d.removed,
      changed: acc.changed + d.changed,
    }),
    { added: 0, removed: 0, changed: 0 },
  );
  const summary =
    days.length === 0
      ? ''
      : `<p class="muted">Last 30 days: ${totals.added.toLocaleString('en-GB')} added, ${totals.removed.toLocaleString('en-GB')} removed, ${totals.changed.toLocaleString('en-GB')} changed — the rows a re-download would make you find yourself.</p>`;
  return `<h2>what changed (last 30 days)</h2>
${summary}${body}
<p class="muted">This register diffs itself every morning. Poll the delta instead of the whole
dataset: <code>GET /v1/changes/${esc(source.slug)}?since=${esc(since)}</code> (add
<code>change=added|removed|changed</code>), or the MCP tool <code>get_changes</code>. One
credit per page, 90-day history — a daily diff of every register fits the free tier.</p>`;
}

/** Trend + breakdown tables shared by the source page and its facet sub-pages. */
function breakdownSections(monthly: MonthlyTrend | null, groups: StatsGroup[]): string[] {
  const sections: string[] = [];
  if (monthly) {
    sections.push(
      `<h2>${esc(monthly.title)}</h2>` +
        tableHtml(
          ['month', 'count'],
          monthly.buckets.map((b) => [b.month, b.count]),
        ),
    );
  }
  for (const group of groups) {
    sections.push(
      `<h2>${esc(group.title)}</h2>` +
        tableHtml(
          ['value', 'records'],
          group.rows.map((r) => [r.value, r.count]),
        ),
    );
  }
  return sections;
}

/** The parent page's index of its facet sub-pages (one bounded list per facet). */
function facetIndexHtml(source: DataSource, facets: FacetStats[]): string {
  return facets
    .filter((facet) => facet.pages.length > 0)
    .map(
      (facet) =>
        `<h2>${esc(facet.title)}</h2>
<table><thead><tr><th>${esc(facet.segment)}</th><th>records</th></tr></thead><tbody>${facet.pages
          .map(
            (p) =>
              `<tr><td><a href="/stats/${esc(source.slug)}/${esc(facet.segment)}/${esc(p.value)}">${esc(p.value)} — ${esc(p.label)}</a></td><td>${p.total.toLocaleString('en-GB')}</td></tr>`,
          )
          .join('')}</tbody></table>`,
    )
    .join('\n');
}

/** Where a `?field=value` query is, as a string for the query poll commands. */
function filterQuery(field: string, value: string): string {
  return `${encodeURIComponent(field)}=${encodeURIComponent(value)}`;
}

function jsonLd(
  source: DataSource,
  baseUrl: string,
  refreshedAt: string | null,
  facet?: { stats: FacetStats; page: FacetPage },
): string {
  const pageUrl = facet
    ? `${baseUrl}/stats/${source.slug}/${facet.stats.segment}/${facet.page.value}`
    : `${baseUrl}/stats/${source.slug}`;
  const query = facet ? `?${filterQuery(facet.stats.field, facet.page.value)}` : '';
  const suffix = facet ? ` — ${facet.stats.segment} ${facet.page.value} (${facet.page.label})` : '';
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `${source.title}${suffix} — statistics`,
    description: source.description,
    url: pageUrl,
    license: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    isAccessibleForFree: true,
    dateModified: refreshedAt ?? undefined,
    creator: { '@type': 'Organization', name: 'gankdat', url: baseUrl },
    ...(facet ? { isPartOf: `${baseUrl}/stats/${source.slug}` } : {}),
    distribution: [
      {
        '@type': 'DataDownload',
        encodingFormat: 'application/json',
        contentUrl: `${baseUrl}/v1/data/${source.slug}${query}`,
      },
      ...(hasChangeFeed(source)
        ? [
            {
              '@type': 'DataDownload',
              name: 'daily change feed',
              encodingFormat: 'application/json',
              contentUrl: `${baseUrl}/v1/changes/${source.slug}${query}`,
            },
          ]
        : []),
    ],
  });
}

/**
 * One facet sub-page, e.g. /stats/uk-trademark-journal/class/09: the
 * value's own headline, trend and breakdowns plus the filtered query and
 * change-feed poll — the page a "trade mark applications this week class 9"
 * search should land on, and the watch it sells.
 */
function facetPageHtml(
  source: DataSource,
  parentTotal: number,
  facet: FacetStats,
  page: FacetPage,
  refreshedAt: string | null,
  baseUrl: string,
): string {
  const updated = refreshedAt ? refreshedAt.slice(0, 10) : 'daily';
  const query = filterQuery(facet.field, page.value);
  const title = `${source.title} — ${facet.segment} ${page.value}: ${page.label}`;
  const share = parentTotal > 0 ? `${((100 * page.total) / parentTotal).toFixed(1)}%` : '—';
  const description = `${page.label} (${facet.segment} ${page.value}): ${page.total.toLocaleString('en-GB')} of ${parentTotal.toLocaleString('en-GB')} records in ${source.title}, updated ${updated}. Weekly and monthly statistics computed from the official feed. Free JSON API and change feed.`;
  const pageUrl = `${baseUrl}/stats/${source.slug}/${facet.segment}/${page.value}`;
  const feed = hasChangeFeed(source)
    ? `<h2>watch this ${esc(facet.segment)}</h2>
<p class="muted">The register diffs itself every morning. Poll only this ${esc(facet.segment)}'s new,
removed and changed rows: <code>GET /v1/changes/${esc(source.slug)}?${esc(query)}&amp;since=YYYY-MM-DD</code>
(add <code>q=&lt;word&gt;</code> for a keyword watch, <code>change=added</code> for new publications only),
or the MCP tool <code>get_changes</code> with <code>filter: {"${esc(facet.field)}": "${esc(page.value)}"}</code>.
One credit per page — a weekly watch on every ${esc(facet.segment)} fits the free tier.
No key at all: subscribe to the <a href="/feeds/${esc(source.slug)}/${esc(facet.segment)}/${esc(page.value)}.xml">Atom feed</a> of this ${esc(facet.segment)} (last 7 days) in any feed reader, Slack, Teams, Zapier, Make or n8n.</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>${esc(title)} — statistics | gankdat</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${pageUrl}">
${hasChangeFeed(source) ? `<link rel="alternate" type="application/atom+xml" title="${esc(title)} — changes" href="${baseUrl}/feeds/${source.slug}/${facet.segment}/${encodeURIComponent(page.value)}.xml">` : ''}
<meta property="og:type" content="article">
<meta property="og:site_name" content="gankdat">
<meta property="og:title" content="${esc(title)} — statistics">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${pageUrl}">
<script type="application/ld+json">${jsonLd(source, baseUrl, refreshedAt, { stats: facet, page })}</script>
<style>${STYLE}</style>
</head>
<body><main>
<p class="muted"><a href="/">gankdat</a> / <a href="/stats">stats</a> / <a href="/stats/${esc(source.slug)}">${esc(source.slug)}</a> / ${esc(facet.segment)} ${esc(page.value)}</p>
<h1>${esc(source.title)} — <b>${esc(facet.segment)} ${esc(page.value)}: ${esc(page.label)}</b></h1>
<p class="muted">${esc(source.description)}</p>
${source.notice ? `<p><b>origin notice:</b> ${esc(source.notice)}</p>` : ''}
<h2>headline</h2>
<table><tbody>
<tr><td>records in ${esc(facet.segment)} ${esc(page.value)}</td><td>${page.total.toLocaleString('en-GB')}</td></tr>
<tr><td>share of the dataset</td><td>${esc(share)}</td></tr>
<tr><td>last refreshed</td><td>${esc(updated)}</td></tr>
</tbody></table>
${breakdownSections(page.monthly, page.groups).join('\n')}
${feed}
<h2>methodology</h2>
<p class="muted">Computed from the same records the gankdat API serves — official
government feeds, refreshed daily, no scraping. A record counts here when its
<code>${esc(facet.field)}</code> field matches <code>${esc(page.value)}</code>, exactly as
<code>GET /v1/data/${esc(source.slug)}?${esc(query)}</code> filters it. This dataset's
licence and personal-data posture are stated in the <a href="/terms">terms</a>. Counts
reflect the current dataset window, not all-time totals. Cite this page with its URL and
the last-refreshed date.</p>
<div class="cta">
<b>Get this ${esc(facet.segment)} as JSON</b><br>
<span class="muted"><code>GET /v1/data/${esc(source.slug)}?${esc(query)}</code> — free tier, 250 req/mo — or MCP for agents</span><br><br>
<a href="/docs">docs</a> <a href="/account">get a key</a> <a href="/llms.txt">llms.txt</a>
</div>
</main></body></html>`;
}

/**
 * The public page of an on-demand dataset (DataSource.lookup): there is no
 * snapshot to count, so the page states what one lookup returns, the fields,
 * the query and the monitor — the same cite-bait slot, nothing computed per
 * request.
 */
function lookupPageHtml(source: DataSource, baseUrl: string): string {
  const spec = source.lookup;
  if (!spec) return '';
  const example = Object.entries(spec.example)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const shape = source.recordSchema as unknown as { shape?: Record<string, unknown> };
  const fields = Object.keys(shape.shape ?? {});
  const description = `${source.title}: one record per lookup by ${spec.keys.join(' or ')}, read live from the official source and cached ${Math.round(spec.cacheTtlSeconds / 3600)} h. Free JSON API and MCP tool.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>${esc(source.title)} — statistics | gankdat</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${baseUrl}/stats/${source.slug}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="gankdat">
<meta property="og:title" content="${esc(source.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${baseUrl}/stats/${source.slug}">
<script type="application/ld+json">${jsonLd(source, baseUrl, null)}</script>
<style>${STYLE}</style>
</head>
<body><main>
<p class="muted"><a href="/">gankdat</a> / <a href="/stats">stats</a></p>
<h1>${esc(source.title)} — <b>lookup</b></h1>
<p class="muted">${esc(source.description)}</p>
${source.notice ? `<p><b>origin notice:</b> ${esc(source.notice)}</p>` : ''}
<h2>headline</h2>
<table><tbody>
<tr><td>records in dataset</td><td>the whole register, one company per lookup</td></tr>
<tr><td>lookup by</td><td>${esc(spec.keys.join(', '))}</td></tr>
<tr><td>freshness</td><td>read from the official source on request, cached ${Math.round(spec.cacheTtlSeconds / 3600)} h</td></tr>
</tbody></table>
<h2>fields in one record</h2>
<p class="muted">${fields.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>
<h2>look one up</h2>
<p class="muted"><code>GET /v1/data/${esc(source.slug)}?${esc(example)}</code> — one credit per lookup, or the MCP tool
<code>query_${esc(source.slug.replaceAll('-', '_'))}</code> with the same arguments. A list of
companies is one call each; the Apify actor takes the whole list and, scheduled daily in its
changes mode, returns only what changed since the previous run.</p>
<h2>methodology</h2>
<p class="muted">Served from the same official source the gankdat API reads — no scraping. This
dataset's licence and personal-data posture are stated in the <a href="/terms">terms</a>. Cite a
record with its URL and the <code>last_refreshed_at</code> the response carries.</p>
<div class="cta">
<b>Get this data as JSON</b><br>
<span class="muted">free tier, 250 req/mo — or MCP for agents</span><br><br>
<a href="/docs">docs</a> <a href="/account">get a key</a> <a href="/llms.txt">llms.txt</a>
</div>
</main></body></html>`;
}

/** The stats page of a source whose origin is paused and whose precomputed blob has expired. */
function pausedPageHtml(source: DataSource, baseUrl: string): string {
  const notice = source.notice ?? '';
  const description = `${source.title}: ${notice} Free JSON API and MCP tool.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>${esc(source.title)} — statistics | gankdat</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${baseUrl}/stats/${source.slug}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="gankdat">
<meta property="og:title" content="${esc(source.title)} — statistics">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${baseUrl}/stats/${source.slug}">
<script type="application/ld+json">${jsonLd(source, baseUrl, null)}</script>
<style>${STYLE}</style>
</head>
<body><main>
<p class="muted"><a href="/">gankdat</a> / <a href="/stats">stats</a></p>
<h1>${esc(source.title)} — <b>statistics</b></h1>
<p class="muted">${esc(source.description)}</p>
<p><b>origin notice:</b> ${esc(notice)}</p>
<h2>headline</h2>
<p class="muted">No statistics are published while the official source is paused; they return with
the first refresh after it resumes. The <a href="/v1/data/${esc(source.slug)}">API</a> and the MCP tool
<code>query_${esc(source.slug.replaceAll('-', '_'))}</code> answer with the same notice until then.</p>
<h2>methodology</h2>
<p class="muted">Computed from the official source the gankdat API reads — no scraping. This
dataset's licence and personal-data posture are stated in the <a href="/terms">terms</a>.</p>
<div class="cta">
<b>Get this data as JSON</b><br>
<span class="muted">free tier, 250 req/mo — or MCP for agents</span><br><br>
<a href="/docs">docs</a> <a href="/account">get a key</a> <a href="/llms.txt">llms.txt</a>
</div>
</main></body></html>`;
}

function pageHtml(
  source: DataSource,
  stats: SourceStats,
  refreshedAt: string | null,
  baseUrl: string,
): string {
  const updated = refreshedAt ? refreshedAt.slice(0, 10) : 'daily';
  const sections = breakdownSections(stats.monthly, stats.groups);
  if (stats.facets) sections.push(facetIndexHtml(source, stats.facets));

  const description = `${source.title}: ${stats.total.toLocaleString('en-GB')} records, updated ${updated}. Monthly statistics computed from the official feed. Free JSON API.`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>${esc(source.title)} — statistics | gankdat</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${baseUrl}/stats/${source.slug}">
${hasChangeFeed(source) ? `<link rel="alternate" type="application/atom+xml" title="${esc(source.title)} — changes" href="${baseUrl}/feeds/${source.slug}.xml">` : ''}
<meta property="og:type" content="article">
<meta property="og:site_name" content="gankdat">
<meta property="og:title" content="${esc(source.title)} — statistics">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${baseUrl}/stats/${source.slug}">
<script type="application/ld+json">${jsonLd(source, baseUrl, refreshedAt)}</script>
<style>${STYLE}</style>
</head>
<body><main>
<p class="muted"><a href="/">gankdat</a> / <a href="/stats">stats</a></p>
<h1>${esc(source.title)} — <b>statistics</b></h1>
<p class="muted">${esc(source.description)}</p>
${source.notice ? `<p><b>origin notice:</b> ${esc(source.notice)}</p>` : ''}
<h2>headline</h2>
<table><tbody>
<tr><td>records in dataset</td><td>${stats.total.toLocaleString('en-GB')}</td></tr>
<tr><td>last refreshed</td><td>${esc(updated)}</td></tr>
</tbody></table>
${sections.join('\n')}
${changesHtml(source, stats)}
<h2>methodology</h2>
<p class="muted">Computed from the same records the gankdat API serves — official
government feeds, refreshed daily, no scraping. This dataset's licence and
personal-data posture are stated in the <a href="/terms">terms</a>. Counts
reflect the current dataset window, not all-time totals. Cite this page with
its URL and the last-refreshed date.</p>
<div class="cta">
<b>Get this data as JSON</b><br>
<span class="muted">free tier, 250 req/mo — or MCP for agents</span><br><br>
<a href="/docs">docs</a> <a href="/account">get a key</a> <a href="/llms.txt">llms.txt</a>
</div>
</main></body></html>`;
}

export const statsRoutes = new Hono<AppEnv>()
  .use('*', async (c, next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const retryAfter = isolateRateLimit(`stats:${ip}`, 120, 60);
    if (retryAfter > 0) {
      c.header('Retry-After', String(retryAfter));
      return c.json(failure('rate_limited', 'Rate limit exceeded; retry later'), 429);
    }
    return next();
  })
  .get('/', (c) => {
    const baseUrl = publicBaseUrl(c.env);
    const items = listSources()
      .map(
        (s) =>
          `<li><a href="/stats/${s.slug}">${esc(s.title)}</a>${hasChangeFeed(s) ? ' <span class="muted">· daily change feed</span>' : ''}${isLookup(s) ? ' <span class="muted">· on-demand lookup</span>' : ''} — <span class="muted">${esc(s.description)}</span></li>`,
      )
      .join('');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" href="/favicon.png">
<title>Dataset statistics | gankdat</title>
<meta name="description" content="Monthly statistics computed from gankdat's UK public-sector datasets — citable, updated daily.">
<link rel="canonical" href="${baseUrl}/stats">
<style>${STYLE}</style></head>
<body><main><p class="muted"><a href="/">gankdat</a> / stats</p>
<h1>dataset <b>statistics</b></h1>
<p class="muted">Computed daily from official feeds. Citable with URL + date.</p>
<ul>${items}</ul></main></body></html>`);
  })
  .get('/:source', async (c) => {
    const source = getSource(c.req.param('source'));
    if (!source) return c.json(failure('not_found', 'Unknown source'), 404);
    if (isLookup(source)) {
      c.header('Cache-Control', 'public, max-age=3600');
      return c.html(lookupPageHtml(source, publicBaseUrl(c.env)));
    }
    // Precomputed read only — this page is public and unauthenticated, so it
    // must never drive an origin refresh or a full-table aggregation.
    const result = await sourceStats(c.env, source);
    if (!result) {
      if (source.notice) {
        // The blob is gone and the origin is paused: the page stays a page (indexed since
        // 2026-10-05) and says why, instead of the JSON 503 Google saw on 2026-10-16.
        c.header('Cache-Control', 'public, max-age=3600');
        return c.html(pausedPageHtml(source, publicBaseUrl(c.env)));
      }
      c.header('Retry-After', '3600');
      return c.json(
        failure('unavailable', 'Statistics are being prepared for this dataset; check back soon'),
        503,
      );
    }
    c.header('Cache-Control', 'public, max-age=3600');
    return c.html(pageHtml(source, result.stats, result.last_refreshed_at, publicBaseUrl(c.env)));
  })
  .get('/:source/:segment/:value', async (c) => {
    const source = getSource(c.req.param('source'));
    const segment = c.req.param('segment');
    const value = c.req.param('value');
    // Only values the source lists exist (bounded programmatic SEO): anything else is a 404,
    // never a page computed on request.
    const spec = source?.stats?.facets?.find((f) => f.segment === segment);
    if (!source || !spec || !spec.values.some((v) => v.value === value)) {
      return c.json(failure('not_found', 'Unknown statistics page'), 404);
    }
    const result = await sourceStats(c.env, source);
    const facet = result?.stats.facets?.find((f) => f.segment === segment);
    const page = facet?.pages.find((p) => p.value === value);
    if (!result || !facet || !page) {
      c.header('Retry-After', '3600');
      return c.json(
        failure('unavailable', 'Statistics are being prepared for this page; check back soon'),
        503,
      );
    }
    c.header('Cache-Control', 'public, max-age=3600');
    return c.html(
      facetPageHtml(
        source,
        result.stats.total,
        facet,
        page,
        result.last_refreshed_at,
        publicBaseUrl(c.env),
      ),
    );
  });
