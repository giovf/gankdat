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
  /** Every distinct logged message, most frequent first (the job log prints them all). */
  messages: { message: string; n: number }[];
  /** The first TOP of `messages`, for the row. */
  top: { message: string; n: number }[];
}

/**
 * An invocation event at error level reads as its request line (`POST https://gankdat.com/mcp`,
 * first read 2026-10-29 19:40): the Worker's own message is the console.error line beside it.
 */
const isRequestLine = (message: string): boolean => /^[A-Z]+ https?:\/\//.test(message);

/** The error-level lines of a Query Builder response, folded by message. */
export function foldErrorLines(body: unknown): ErrorLines {
  const result = isRecord(body) && 'result' in body ? body.result : body;
  const rows = firstArray(result) ?? [];
  const counts = new Map<string, number>();
  let lines = 0;
  let requests = 0;
  for (const row of rows) {
    const message = errorLineOf(row);
    if (message === null) continue;
    lines += 1;
    if (isRequestLine(message)) {
      requests += 1;
      continue;
    }
    const key = message.slice(0, MESSAGE_CHARS);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const messages = [...counts.entries()]
    .map(([message, n]) => ({ message, n }))
    .sort((a, b) => b.n - a.n || a.message.localeCompare(b.message));
  return { lines, requests, messages, top: messages.slice(0, TOP) };
}

/** The Daily numbers clause: `worker errors 24h: N (msg ×n, …)` or `worker errors 24h: 0`. */
export function errorLinesNote(folded: ErrorLines, hours = ERROR_LOG_HOURS): string {
  if (folded.lines === 0) return `worker errors ${hours}h: 0`;
  const named = folded.top.map((t) => `${t.message} ×${t.n}`).join(', ');
  const more = folded.messages.length - folded.top.length;
  return `worker errors ${hours}h: ${folded.lines} (${named}${more > 0 ? ` +${more} more` : ''})`;
}
