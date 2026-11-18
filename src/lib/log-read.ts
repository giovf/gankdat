/**
 * A complete Workers Logs read, or one that says what it lacks (gankdat
 * `worker-logs-read-completeness`, 2026-11-18). Until today every log read here was one POST with a
 * `limit` and no look at what came back beside the events: eight `worker logs` dispatches returned
 * 140 POST /mcp records for a window the traffic rows count at about 12,000, two identical error
 * queries ninety seconds apart printed 160 lines and then 0, and each reading was taken as the
 * whole truth. Cloudflare's "Run a query" reference (read through the relay,
 * docs/relay/responses/cf-logs-query-2026-11-18/4.txt) names three places a line can go missing,
 * and the response carries a number for each:
 *
 *  - `statistics.abr_level` — "The level of Adaptive Bit Rate (ABR) sampling used for the query. If
 *    empty the ABR level is 1": above 1 the database answered from a sampled copy of the table, so
 *    lines are absent and two runs of one query can differ. "Narrower timeframes produce faster
 *    responses and more specific results", so a sampled window is halved and read again.
 *  - `events.count` — "Total number of events matching the query (may exceed the number returned
 *    due to limits)"; `limit` is at most 2000 and the next page is asked with `offset` = "the
 *    $metadata.id of the last event" and `offsetDirection: 'next'`.
 *  - `sampleInterval` on a `count` calculation — "1 / (the sampling rate applied when it was
 *    ingested): the Worker's head_sampling_rate multiplied by any platform sampling applied to the
 *    account or script. A value of 1 means none of the matched events were sampled": above 1 the
 *    events were never stored, and no read can return them.
 *
 * Pure but for the `post` callback the two scripts pass in; the head line it renders is the first
 * thing a routine reads, so silence is never again taken for absence.
 */

/** The API's own cap on `limit` for the events view. */
export const LOG_PAGE_LIMIT = 2000;
/** Most POSTs one read may spend on halving sampled windows and paging. */
export const LOG_READ_MAX_REQUESTS = 16;
/** A window this short is not halved again, whatever its ABR level. */
const MIN_WINDOW_MS = 60 * 1000;

export type LogQuery = Record<string, unknown> & { timeframe: { from: number; to: number } };

export interface LogReadStats {
  /** Distinct events collected. */
  returned: number;
  /** Sum of `events.count` over the windows read; null when no response carried one. */
  matched: number | null;
  /** Sum of `statistics.rows_read`; null when no response carried one. */
  rowsRead: number | null;
  /** Highest `statistics.abr_level` among the windows whose events were kept (1 = full data). */
  abrLevel: number;
  /** Highest ABR level of an answer that was discarded and re-read in halves (1 = none was). */
  widestAbrLevel: number;
  /** Windows the timeframe ended up split into. */
  windows: number;
  /** POSTs made. */
  requests: number;
  /** The caller's cap on events. */
  want: number;
  /** Why the read is partial, in the order met; empty when it is complete. */
  partial: string[];
}

export interface LogRead {
  /** The collected events, in the order the API returned them (newest window first). */
  events: unknown[];
  stats: LogReadStats;
  /** A response-shaped body holding every collected event, for the existing folders. */
  body: { result: { events: { events: unknown[] } } };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const numberOf = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const n = (v: number): string => v.toLocaleString('en-GB', { maximumFractionDigits: 1 });

const resultOf = (body: unknown): Record<string, unknown> => {
  if (!isRecord(body)) return {};
  return isRecord(body.result) ? body.result : body;
};

/** The events of one response: `result.events.events`, or `result.events` when it is the array. */
export function pageEvents(body: unknown): unknown[] {
  const events = resultOf(body).events;
  if (Array.isArray(events)) return events;
  if (isRecord(events) && Array.isArray(events.events)) return events.events;
  return [];
}

/** What one response says about its own completeness. */
export function pageStats(body: unknown): {
  matched: number | null;
  rowsRead: number | null;
  abrLevel: number;
} {
  const result = resultOf(body);
  const events = isRecord(result.events) ? result.events : {};
  const run = isRecord(result.run) ? result.run : {};
  const statistics = isRecord(result.statistics)
    ? result.statistics
    : isRecord(run.statistics)
      ? run.statistics
      : {};
  const abr = numberOf(statistics.abr_level);
  return {
    matched: numberOf(events.count),
    rowsRead: numberOf(statistics.rows_read),
    // "If empty the ABR level is 1"; the reference's example prints 0 for an unset number.
    abrLevel: abr !== null && abr > 1 ? abr : 1,
  };
}

/** `$metadata.id` of an event: the pagination cursor and the de-duplication key. */
export function eventId(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const meta = isRecord(event.$metadata) ? event.$metadata : {};
  const id = meta.id ?? event['$metadata.id'];
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * Read up to `want` events of `query`'s timeframe: a window answered from sampled data (ABR level
 * above 1) is halved and read again while the request budget lasts, and a window with more
 * matches than one page holds is paged by cursor. Whatever still falls short is named in
 * `stats.partial`.
 */
export async function readLogEvents(
  post: (query: LogQuery) => Promise<unknown>,
  query: LogQuery,
  want: number,
  maxRequests = LOG_READ_MAX_REQUESTS,
): Promise<LogRead> {
  const seen = new Set<string>();
  const events: unknown[] = [];
  const stats: LogReadStats = {
    returned: 0,
    matched: null,
    rowsRead: null,
    abrLevel: 1,
    widestAbrLevel: 1,
    windows: 0,
    requests: 0,
    want,
    partial: [],
  };
  const note = (why: string): void => {
    if (!stats.partial.includes(why)) stats.partial.push(why);
  };
  const add = (a: number | null, b: number | null): number | null =>
    b === null ? a : (a ?? 0) + b;
  const collect = (page: unknown[]): void => {
    for (const event of page) {
      const id = eventId(event);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      if (events.length < want) events.push(event);
    }
  };

  // Newest window first, so a capped read keeps the newest lines as a single query would.
  const pending: { from: number; to: number }[] = [{ ...query.timeframe }];
  while (pending.length > 0) {
    const window = pending.shift()!;
    if (events.length >= want) {
      note(`limit ${want} reached before the oldest window was read`);
      break;
    }
    if (stats.requests >= maxRequests) {
      note(`request budget ${maxRequests} spent before the oldest window was read`);
      break;
    }
    const limit = Math.min(LOG_PAGE_LIMIT, want - events.length);
    stats.requests += 1;
    const first = await post({ ...query, timeframe: window, limit });
    const firstStats = pageStats(first);
    stats.rowsRead = add(stats.rowsRead, firstStats.rowsRead);

    // A sampled answer: halve the window and read both halves, while the budget allows it.
    const span = window.to - window.from;
    if (
      firstStats.abrLevel > 1 &&
      span >= 2 * MIN_WINDOW_MS &&
      stats.requests + pending.length + 2 <= maxRequests
    ) {
      stats.widestAbrLevel = Math.max(stats.widestAbrLevel, firstStats.abrLevel);
      const mid = window.from + Math.floor(span / 2);
      pending.unshift({ from: mid, to: window.to }, { from: window.from, to: mid });
      continue;
    }

    stats.windows += 1;
    stats.matched = add(stats.matched, firstStats.matched);
    stats.abrLevel = Math.max(stats.abrLevel, firstStats.abrLevel);
    let page = pageEvents(first);
    let pageLimit = limit;
    collect(page);
    // More matches than the page held: follow the cursor.
    while (page.length >= pageLimit && events.length < want) {
      const cursor = eventId(page[page.length - 1]);
      if (cursor === null) {
        note('events carry no $metadata.id, so the next page could not be asked');
        break;
      }
      if (stats.requests >= maxRequests) {
        note(`request budget ${maxRequests} spent while paging`);
        break;
      }
      pageLimit = Math.min(LOG_PAGE_LIMIT, want - events.length);
      stats.requests += 1;
      const next = await post({
        ...query,
        timeframe: window,
        limit: pageLimit,
        offset: cursor,
        offsetDirection: 'next',
      });
      const nextStats = pageStats(next);
      stats.rowsRead = add(stats.rowsRead, nextStats.rowsRead);
      stats.abrLevel = Math.max(stats.abrLevel, nextStats.abrLevel);
      const before = events.length;
      page = pageEvents(next);
      collect(page);
      if (events.length === before) break; // the cursor returned nothing new
    }
  }

  stats.returned = events.length;
  if (stats.abrLevel > 1) {
    note(`ABR level ${stats.abrLevel}: answered from sampled data, lines can be missing`);
  }
  if (stats.matched !== null && stats.matched > stats.returned && events.length >= want) {
    note(`limit ${want} reached`);
  }
  return { events, stats, body: { result: { events: { events } } } };
}

/** The same filters as a `count` calculation, whose `sampleInterval` names sampling at ingest. */
export function storedCountQuery(query: LogQuery): LogQuery {
  const parameters = isRecord(query.parameters) ? query.parameters : {};
  const rest: Record<string, unknown> = { ...query };
  for (const key of ['limit', 'offset', 'offsetDirection']) delete rest[key];
  return {
    ...rest,
    queryId: `${typeof query.queryId === 'string' ? query.queryId : 'log-read'}-count`,
    timeframe: query.timeframe,
    parameters: { ...parameters, calculations: [{ operator: 'count' }], groupBys: [] },
    view: 'calculations',
    ignoreSeries: true,
  };
}

export interface StoredCount {
  count: number;
  sampleInterval: number | null;
  /** ABR level of the count's own answer; above 1 the count is an estimate. */
  abrLevel: number;
}

/**
 * Hold a finished read against the store's count for the same filters. The first live read
 * (worker logs run 37, 2026-11-18) answered `events.count: 5` for a `limit: 5` page while the count
 * calculation said 177: `events.count` is bounded by the page, so the store's count is the total
 * a read is measured against. A shortfall beyond 2 % (requests land between the two calls) is
 * named in `partial`.
 */
export function withStoredCount(stats: LogReadStats, stored: StoredCount | null): LogReadStats {
  if (stored === null) return stats;
  const short = stats.returned < stored.count * 0.98 - 2;
  const why =
    stats.returned >= stats.want
      ? `limit ${stats.want} reached`
      : `the store counts ${n(stored.count)} for the same filters`;
  return {
    ...stats,
    matched: Math.max(stored.count, stats.returned),
    partial: short && stats.partial.length === 0 ? [why] : stats.partial,
  };
}

/** `count` and `sampleInterval` of the first aggregate of a calculations response, when carried. */
export function storedCountOf(body: unknown): StoredCount | null {
  const calculations = resultOf(body).calculations;
  if (!Array.isArray(calculations)) return null;
  for (const calculation of calculations) {
    const aggregates = isRecord(calculation) ? calculation.aggregates : null;
    if (!Array.isArray(aggregates)) continue;
    for (const aggregate of aggregates) {
      if (!isRecord(aggregate)) continue;
      const count = numberOf(aggregate.count) ?? numberOf(aggregate.value);
      if (count === null) continue;
      return {
        count,
        sampleInterval: numberOf(aggregate.sampleInterval) ?? numberOf(aggregate.interval),
        abrLevel: pageStats(body).abrLevel,
      };
    }
  }
  return null;
}

/**
 * The head line of a read: `log read: 140 returned of 12,034 matched — complete` or
 * `… — PARTIAL: <why>; <why>`, then how it was read. Plain text, no braces (GitHub's log masking).
 */
export function logReadLine(stats: LogReadStats): string {
  const matched = stats.matched === null ? 'matched n/a' : `of ${n(stats.matched)} matched`;
  // (`matched` is the store's count once `withStoredCount` has run; a page's own count before it.)
  const verdict =
    stats.partial.length > 0
      ? `PARTIAL: ${stats.partial.join('; ')}`
      : stats.matched === null
        ? 'no match count in the response, completeness unknown'
        : 'complete';
  const how =
    `${stats.requests} request${stats.requests === 1 ? '' : 's'}, ` +
    `${stats.windows} window${stats.windows === 1 ? '' : 's'}, ABR level ${stats.abrLevel}` +
    (stats.widestAbrLevel > 1
      ? ` after halving (the whole window was answered at level ${stats.widestAbrLevel}, sampled)`
      : '') +
    (stats.rowsRead === null ? '' : `, ${n(stats.rowsRead)} rows scanned`);
  return `log read: ${n(stats.returned)} returned ${matched} — ${verdict} (${how})`;
}

/** The ingest line: what the store holds for the same filters, and whether it was sampled. */
export function storedCountLine(stored: StoredCount | null, why = ''): string {
  if (stored === null) return `log store: count n/a${why ? ` (${why})` : ''}`;
  const interval = stored.sampleInterval;
  if (interval === null) return `log store: about ${n(stored.count)} events, sample interval n/a`;
  if (stored.abrLevel > 1 && interval <= 1) {
    return `log store: about ${n(stored.count)} events (estimated: the count was answered at ABR level ${stored.abrLevel}), sample interval 1`;
  }
  return interval > 1
    ? `log store: about ${n(stored.count)} events estimated, SAMPLED AT INGEST: sample interval ${n(interval)} (about 1 event in ${n(interval)} was stored; the rest cannot be read)`
    : `log store: ${n(stored.count)} events, sample interval 1 (nothing dropped at ingest)`;
}
