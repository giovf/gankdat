// The Worker's own `level: error` log lines of the last day, read from Workers Logs by the
// metrics job (gankdat `apify-companies-house-qa-repair`, 2026-10-29): app.onError answers every
// uncaught throw with a bare `internal` 500 and logs `{ level: 'error', requestId, message,
// stack }` — Apify's QA runner got that 500 from the company lookup for three days, and the
// repo held no reading of the message behind it (no sandbox can read Workers Logs, the Daily
// numbers row counted refresh errors only). The row now names the day's error messages, most
// frequent first, so a 500 on any route is diagnosable from the repo the next morning.
import { STATS_LOG_SERVICE } from './crawler-hits.ts';

export const ERROR_LOG_HOURS = 24;
export const ERROR_LOG_LIMIT = 500;
const TOP = 3;
const MESSAGE_CHARS = 90;

/** Query Builder body for the Worker's error-level lines in the last `hours`, newest first. */
export function errorLogQuery(
  nowMs: number,
  hours = ERROR_LOG_HOURS,
  limit = ERROR_LOG_LIMIT,
): Record<string, unknown> {
  return {
    queryId: 'worker-error-lines',
    timeframe: { from: nowMs - hours * 60 * 60 * 1000, to: nowMs },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$metadata.service', operation: 'eq', value: STATS_LOG_SERVICE, type: 'string' },
        { key: '$metadata.level', operation: 'eq', value: 'error', type: 'string' },
      ],
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

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : String(v));

/**
 * One error line's message from a Query Builder event, or null when the event is not an
 * error-level line. Workers Logs keeps a JSON console.error as the parsed object under `source`
 * (wave-logs.ts, 2026-10-27), so the handler's `message` field is read from there first; a plain
 * string log carries its text as the message.
 */
export function errorLineOf(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const meta = isRecord(raw.$metadata) ? raw.$metadata : {};
  const logged = isRecord(raw.source) ? raw.source : null;
  const level = text(meta.level ?? logged?.level ?? raw.level);
  if (level !== 'error') return null;
  let message = text(logged?.message ?? meta.message ?? raw.message);
  if (message.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(message);
      if (isRecord(parsed) && typeof parsed.message === 'string') message = parsed.message;
    } catch {
      /* not JSON — keep the text */
    }
  }
  message = message.replace(/\s+/g, ' ').trim();
  return message === '' ? null : message;
}

export interface ErrorLines {
  /** Error-level lines in the window, the invocation events included. */
  lines: number;
  /** Error-level invocation events (`METHOD https://…`): the request a thrown error belonged to. */
  requests: number;
  /**
   * Every distinct logged message, most frequent first (the job log prints them all), with the
   * request paths it was thrown on — the invocation event that shares the line's requestId.
   */
  messages: { message: string; n: number; paths: { path: string; n: number }[] }[];
  /** The first TOP of `messages`, for the row. */
  top: { message: string; n: number }[];
  /**
   * The error-level request events folded by `METHOD <path family> <status>`, most frequent
   * first (gankdat `worker-errors-request-paths`, 2026-10-30): the platform marks a 5xx
   * response's invocation event `level: error`, and 50 of the 10-30 row's 54 lines were such
   * events — the journal's missing class pages answering 503 to crawlers, uk-planning's paused
   * origin to the Apify actor — counted and never named. The status is the event's
   * `$workers.event.response.status` (the live shape read 2026-10-30 18:44); a path's segments
   * past the third fold to `*`, so `/stats/<slug>/<segment>/<value>` reads as one route.
   */
  routes: { route: string; n: number }[];
}

/** A request path's family: its first three segments, anything after them as `*`. */
export function routeFamily(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts.length > 3 ? `/${parts.slice(0, 3).join('/')}/*` : `/${parts.join('/')}`;
}

/** Nested read: `$workers.event.response.status` from the event object or a flat dotted key. */
function fieldOf(row: Record<string, unknown>, path: string[]): unknown {
  const flat = row[path.join('.')];
  if (flat !== undefined) return flat;
  let cur: unknown = row;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** The response status of an invocation event, or null when the row does not carry one. */
function statusOf(row: unknown): number | null {
  if (!isRecord(row)) return null;
  const v = fieldOf(row, ['$workers', 'event', 'response', 'status']);
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * An invocation event at error level reads as its request line (`POST https://gankdat.com/mcp`,
 * first read 2026-10-29 19:40): the Worker's own message is the console.error line beside it, and
 * both carry the invocation's `$metadata.requestId` (wave-logs.ts, 2026-10-27).
 */
const REQUEST_LINE = /^([A-Z]+) (https?:\/\/\S+)/;

const requestIdOf = (raw: unknown): string => {
  if (!isRecord(raw)) return '';
  const meta = isRecord(raw.$metadata) ? raw.$metadata : {};
  return text(meta.requestId ?? raw.requestId);
};

/** D1's per-incident reference ids would make every internal error its own message. */
const normalise = (message: string): string =>
  message.replace(/reference = [a-z0-9]+/g, 'reference = …');

/** The error-level lines of a Query Builder response, folded by message, each with its request paths. */
export function foldErrorLines(body: unknown): ErrorLines {
  const result = isRecord(body) && 'result' in body ? body.result : body;
  const rows = firstArray(result) ?? [];
  const pathByRequest = new Map<string, string>();
  const thrown: { key: string; requestId: string }[] = [];
  const routeCounts = new Map<string, number>();
  let lines = 0;
  let requests = 0;
  for (const row of rows) {
    const message = errorLineOf(row);
    if (message === null) continue;
    lines += 1;
    const request = REQUEST_LINE.exec(message);
    if (request) {
      requests += 1;
      try {
        const path = new URL(request[2]!).pathname;
        pathByRequest.set(requestIdOf(row), path);
        const status = statusOf(row);
        const route = `${request[1]} ${routeFamily(path)} ${status ?? '?'}`;
        routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
      } catch {
        /* not a URL after all — the message stays a count */
      }
      continue;
    }
    thrown.push({ key: normalise(message).slice(0, MESSAGE_CHARS), requestId: requestIdOf(row) });
  }
  const counts = new Map<string, { n: number; paths: Map<string, number> }>();
  for (const t of thrown) {
    const entry = counts.get(t.key) ?? { n: 0, paths: new Map<string, number>() };
    entry.n += 1;
    const path = (t.requestId && pathByRequest.get(t.requestId)) || '';
    if (path) entry.paths.set(path, (entry.paths.get(path) ?? 0) + 1);
    counts.set(t.key, entry);
  }
  const messages = [...counts.entries()]
    .map(([message, e]) => ({
      message,
      n: e.n,
      paths: [...e.paths.entries()]
        .map(([path, n]) => ({ path, n }))
        .sort((a, b) => b.n - a.n || a.path.localeCompare(b.path)),
    }))
    .sort((a, b) => b.n - a.n || a.message.localeCompare(b.message));
  const routes = [...routeCounts.entries()]
    .map(([route, n]) => ({ route, n }))
    .sort((a, b) => b.n - a.n || a.route.localeCompare(b.route));
  return {
    lines,
    requests,
    messages,
    top: messages.slice(0, TOP).map(({ message, n }) => ({ message, n })),
    routes,
  };
}

/**
 * The Daily numbers clause: `worker errors 24h: N (msg ×n, …; requests: GET /path 503 ×n, …)` or
 * `worker errors 24h: 0`. The thrown messages come first, the 5xx request events by route after
 * `requests:`, each list cut to TOP with a `+N more`; the named counts add up to the line total.
 */
export function errorLinesNote(folded: ErrorLines, hours = ERROR_LOG_HOURS): string {
  if (folded.lines === 0) return `worker errors ${hours}h: 0`;
  const cut = <T>(items: T[], render: (item: T) => string): string => {
    const more = items.length - TOP;
    return items.slice(0, TOP).map(render).join(', ') + (more > 0 ? ` +${more} more` : '');
  };
  const parts: string[] = [];
  if (folded.messages.length > 0) parts.push(cut(folded.messages, (m) => `${m.message} ×${m.n}`));
  if (folded.routes.length > 0) {
    parts.push(`requests: ${cut(folded.routes, (r) => `${r.route} ×${r.n}`)}`);
  }
  return `worker errors ${hours}h: ${folded.lines}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`;
}
