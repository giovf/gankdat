/**
 * AI-crawler hits on the stats pages (new-ventures `spike-pay-per-crawl-stats-pages`, 2026-10-17):
 * Cloudflare's Pay Per Crawl charges AI crawlers per fetch of pages they already take, so the
 * spike needs one number nothing in the repo counted — how many fetches of `/stats/<slug>` come
 * from the AI crawler families (GPTBot, ClaudeBot, PerplexityBot, Bytespider, CCBot …). Three
 * readings, each pure here and POSTed by scripts/metrics.mjs: the Worker's own structured request
 * line (middleware/logging.ts writes `path` and `userAgent`; Workers Logs keeps 7 days on Workers
 * Paid and does not record request headers, so the line is the only place the user agent lives),
 * the zone's HTTP analytics (GraphQL httpRequestsAdaptiveGroups by userAgent, path like `/stats%`),
 * and the `/mcp` surface's Analytics Engine rows (blob2 = user agent, 30 days) as the long-window
 * proxy. Families, not full strings: a crawler's version suffix changes weekly.
 */

/** The AI crawler families Cloudflare's AI Crawl Control lists, matched on the user agent. */
export const AI_CRAWLERS: ReadonlyArray<{ family: string; pattern: RegExp }> = [
  { family: 'GPTBot', pattern: /GPTBot/i },
  { family: 'ChatGPT-User', pattern: /ChatGPT-User/i },
  { family: 'OAI-SearchBot', pattern: /OAI-SearchBot/i },
  { family: 'ClaudeBot', pattern: /ClaudeBot|Claude-Web|anthropic-ai/i },
  { family: 'Claude-User', pattern: /Claude-User|Claude-SearchBot/i },
  { family: 'PerplexityBot', pattern: /PerplexityBot|Perplexity-User/i },
  { family: 'Bytespider', pattern: /Bytespider/i },
  { family: 'CCBot', pattern: /CCBot/i },
  { family: 'Google-Extended', pattern: /Google-Extended|GoogleOther/i },
  { family: 'Applebot', pattern: /Applebot/i },
  { family: 'Amazonbot', pattern: /Amazonbot/i },
  { family: 'Meta-ExternalAgent', pattern: /meta-externalagent|FacebookBot|meta-externalfetcher/i },
  { family: 'cohere-ai', pattern: /cohere-ai|cohere-training-data-crawler/i },
  { family: 'Diffbot', pattern: /Diffbot/i },
  { family: 'DuckAssistBot', pattern: /DuckAssistBot/i },
  { family: 'MistralAI-User', pattern: /MistralAI-User/i },
  { family: 'AI2Bot', pattern: /AI2Bot|Ai2Bot-Dolma/i },
  { family: 'PetalBot', pattern: /PetalBot/i },
  { family: 'ImagesiftBot', pattern: /ImagesiftBot/i },
  { family: 'Timpibot', pattern: /Timpibot/i },
  { family: 'omgili', pattern: /omgili|webzio/i },
  { family: 'YouBot', pattern: /YouBot/i },
  { family: 'Kangaroo Bot', pattern: /Kangaroo Bot/i },
  { family: 'SemrushBot-OCOB', pattern: /SemrushBot-OCOB/i },
  { family: 'Bingbot', pattern: /bingbot/i },
];

/** The AI crawler family a user agent belongs to, or null for everything else. */
export function crawlerFamily(userAgent: string): string | null {
  return AI_CRAWLERS.find((c) => c.pattern.test(userAgent))?.family ?? null;
}

/** Hits by family: `total` is every row counted, `ai` the rows an AI family claimed. */
export interface CrawlerHits {
  total: number;
  ai: number;
  byFamily: Record<string, number>;
}

/** Fold `(userAgent, hits)` rows into family counts, in descending order of hits. */
export function foldFamilies(rows: Iterable<{ userAgent: string; hits: number }>): CrawlerHits {
  const byFamily: Record<string, number> = {};
  let total = 0;
  let ai = 0;
  for (const { userAgent, hits } of rows) {
    if (!Number.isFinite(hits) || hits <= 0) continue;
    total += hits;
    const family = crawlerFamily(userAgent);
    if (!family) continue;
    ai += hits;
    byFamily[family] = (byFamily[family] ?? 0) + hits;
  }
  const sorted = Object.fromEntries(Object.entries(byFamily).sort((a, b) => b[1] - a[1]));
  return { total: Math.round(total), ai: Math.round(ai), byFamily: sorted };
}

/** `GPTBot 120, ClaudeBot 31` (top `max` families), or `none`. */
export function familiesText(hits: CrawlerHits, max = 6): string {
  const parts = Object.entries(hits.byFamily)
    .slice(0, max)
    .map(([f, n]) => `${f} ${Math.round(n)}`);
  return parts.length ? parts.join(', ') : 'none';
}

/** Worker name in wrangler.jsonc (`$metadata.service` in Workers Logs). */
export const STATS_LOG_SERVICE = 'faceless-api';
/** The text every stats-page request line carries (middleware/logging.ts JSON, path first). */
export const STATS_LOG_NEEDLE = '"path":"/stats';
export const STATS_LOG_HOURS = 7 * 24;
export const STATS_LOG_LIMIT = 5000;

/**
 * Query Builder body for the Worker's own request lines about `/stats…` in the last `hours`,
 * newest first. Only the documented shape wave-logs.ts already uses (service filter + needle);
 * the user agent is read from the line itself, never from a field the API might not index.
 */
export function statsPageLogQuery(
  nowMs: number,
  hours = STATS_LOG_HOURS,
  limit = STATS_LOG_LIMIT,
): Record<string, unknown> {
  return {
    queryId: 'stats-page-crawlers',
    timeframe: { from: nowMs - hours * 60 * 60 * 1000, to: nowMs },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$metadata.service', operation: 'eq', value: STATS_LOG_SERVICE, type: 'string' },
      ],
      needle: { value: STATS_LOG_NEEDLE, isRegex: false, matchCase: true },
      calculations: [],
      groupBys: [],
    },
    view: 'events',
    limit,
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function firstArray(v: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (!isRecord(v) || depth > 4) return null;
  for (const key of ['events', 'result', 'data', 'rows']) {
    if (key in v) {
      const found = firstArray(v[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** One request line's `(path, userAgent)` from a Query Builder event, or null when it is not one. */
export function statsLineOf(raw: unknown): { path: string; userAgent: string } | null {
  if (!isRecord(raw)) return null;
  const meta = isRecord(raw.$metadata) ? raw.$metadata : {};
  const message = meta.message ?? raw.message;
  if (typeof message !== 'string' || !message.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (!isRecord(parsed) || typeof parsed.path !== 'string') return null;
    if (!parsed.path.startsWith('/stats')) return null;
    return {
      path: parsed.path,
      userAgent: typeof parsed.userAgent === 'string' ? parsed.userAgent : '',
    };
  } catch {
    return null;
  }
}

/** The stats-page request lines in a Query Builder response, folded by crawler family. */
export function foldStatsLogEvents(body: unknown): CrawlerHits & { lines: number } {
  const result = isRecord(body) && 'result' in body ? body.result : body;
  const rows = firstArray(result) ?? [];
  const lines = rows
    .map(statsLineOf)
    .filter((l): l is { path: string; userAgent: string } => l !== null);
  return {
    ...foldFamilies(lines.map((l) => ({ userAgent: l.userAgent, hits: 1 }))),
    lines: rows.length,
  };
}

/**
 * GraphQL selection for the zone's `/stats…` requests by user agent between two ISO datetimes
 * (httpRequestsAdaptiveGroups; the zone tag comes from the zones list, never from the repo).
 */
export function zoneStatsQuery(zoneTag: string, fromIso: string, toIso: string): string {
  return `{ viewer { zones(filter: { zoneTag: "${zoneTag}" }) { httpRequestsAdaptiveGroups(limit: 1000, filter: { datetime_geq: "${fromIso}", datetime_lt: "${toIso}", clientRequestPath_like: "/stats%" }, orderBy: [count_DESC]) { count dimensions { userAgent } } } } }`;
}

/** `(userAgent, hits)` rows from a zone GraphQL response body. */
export function zoneStatsRows(body: unknown): Array<{ userAgent: string; hits: number }> {
  if (!isRecord(body)) return [];
  const data = isRecord(body.data) ? body.data : {};
  const viewer = isRecord(data.viewer) ? data.viewer : {};
  const zones = Array.isArray(viewer.zones) ? viewer.zones : [];
  const zone: unknown = zones[0];
  const groups =
    isRecord(zone) && Array.isArray(zone.httpRequestsAdaptiveGroups)
      ? zone.httpRequestsAdaptiveGroups
      : [];
  return groups.flatMap((g: unknown) => {
    if (!isRecord(g)) return [];
    const dims = isRecord(g.dimensions) ? g.dimensions : {};
    return [
      {
        userAgent: typeof dims.userAgent === 'string' ? dims.userAgent : '',
        hits: Number(g.count ?? 0),
      },
    ];
  });
}

/** Analytics Engine SQL: `/mcp` requests by user agent over `days` (sampling-corrected). */
export function mcpCrawlerSql(days = 30): string {
  return `SELECT blob2 AS ua, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE timestamp > NOW() - INTERVAL '${days}' DAY GROUP BY ua ORDER BY n DESC LIMIT 500`;
}

/** The Daily numbers clause: one reading per surface, `n/a (reason)` where a reading failed. */
export function crawlerNote(parts: {
  statsLogs: (CrawlerHits & { lines: number; hours: number; limit: number }) | { error: string };
  zone: (CrawlerHits & { days: number }) | { error: string };
  mcp: (CrawlerHits & { days: number }) | { error: string };
}): string {
  const logs =
    'error' in parts.statsLogs
      ? `n/a (${parts.statsLogs.error})`
      : `${parts.statsLogs.total}${parts.statsLogs.lines >= parts.statsLogs.limit ? '+' : ''} fetches/${parts.statsLogs.hours / 24}d, AI ${parts.statsLogs.ai} (${familiesText(parts.statsLogs)})`;
  const zone =
    'error' in parts.zone
      ? `n/a (${parts.zone.error})`
      : `${parts.zone.total} req/${parts.zone.days}d, AI ${parts.zone.ai} (${familiesText(parts.zone)})`;
  const mcp =
    'error' in parts.mcp
      ? `n/a (${parts.mcp.error})`
      : `${parts.mcp.total} req/${parts.mcp.days}d, AI ${parts.mcp.ai} (${familiesText(parts.mcp)})`;
  return `stats crawlers: logs ${logs}; zone ${zone}; /mcp ${mcp}`;
}
