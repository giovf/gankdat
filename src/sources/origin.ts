import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Origin trace (refresh-zero-records-evidence, 2026-10-11): what the origin served when a
 * refresh yields nothing. The zero-record guard in cache.ts / d1store.ts used to say only
 * "refresh returned 0 records", so a 200 with an empty `entities` array (dataset emptied or
 * renamed upstream), a 5xx HTML page the parser skipped and a truncated body all read the same
 * in the Daily numbers row and the relay had to be asked the next day (uk-contract-awards
 * 10-03, uk-planning 10-10). Sources fetch their origin through `originFetch` (a drop-in for
 * `fetch`); the store layer runs the refresh inside `traceOrigin`, which keeps the first page
 * that refresh read — URL, status, byte count and the body's shape (top-level keys of a JSON
 * object, array length, or the first 80 characters) — and `zeroRecordsError` puts it in the
 * message. Generic: no per-dataset logic; a source that never calls `originFetch` (fixtures,
 * a lookup) gets the old message with `no origin page seen`.
 *
 * The body is never consumed: a clone is read up to PEEK bytes and cancelled, so a 200 MB zip
 * costs one small buffer. Everything here is best-effort — a describe failure records the
 * status alone and never fails the refresh.
 */

export interface OriginPage {
  method: string;
  url: string;
  status: number;
  /** Content-Length, or the bytes actually seen when the origin sends no length. */
  bytes: number | null;
  /** True when `bytes` is a floor (body longer than the peek, no Content-Length). */
  bytesAtLeast: boolean;
  /** `keys a,b,c` for a JSON object, `array[N]`, or `text "…"` (first 80 chars). */
  shape: string;
}

export interface OriginTrace {
  first: OriginPage | null;
  last: OriginPage | null;
  pages: number;
}

/** Bytes of the body peeked for the shape (a JSON page under this size is parsed whole). */
const PEEK = 4096;
const TEXT_CHARS = 80;
const MAX_KEYS = 8;

const traces = new AsyncLocalStorage<OriginTrace>();

/** Run one refresh with a fresh trace; `originFetch` calls inside it are recorded. */
export function traceOrigin<T>(fn: () => Promise<T>): Promise<T> {
  return traces.run({ first: null, last: null, pages: 0 }, fn);
}

/** The trace of the refresh in progress, if any. */
export function currentOriginTrace(): OriginTrace | undefined {
  return traces.getStore();
}

/** `fetch` for origin pages: identical to the global, plus the trace record. */
export async function originFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  const trace = traces.getStore();
  if (!trace) return res;
  try {
    const page = await describeResponse(init?.method ?? 'GET', String(input), res);
    trace.pages += 1;
    if (!trace.first) trace.first = page;
    trace.last = page;
  } catch {
    // describing is diagnostics only — the refresh must behave exactly as before
  }
  return res;
}

/**
 * The origin answered 5xx (or nothing) on every read a refresh was allowed — the day's fault
 * is the origin's, not the parser's. The runner-side refresh logs this as a `skipped`
 * refresh_log row instead of `error` (refresh-uk-insolvency-2026-10-11): The Gazette's one
 * 503 on 2026-10-10 13:00 was read as a two-day failure, filed as a queue item and the Daily
 * numbers row kept naming it after the next refresh had already written 1000 records. The
 * last snapshot stays served either way; a source whose origin stays down shows up through
 * the two-day `no successful refresh since` reading, which also quotes the skipped row.
 */
export class OriginUnavailableError extends Error {
  readonly status: number;
  readonly attempts: number;
  constructor(host: string, status: number, attempts: number) {
    super(`${host} responded ${status}${attempts > 1 ? ` after ${attempts} reads` : ''}`);
    this.name = 'OriginUnavailableError';
    this.status = status;
    this.attempts = attempts;
  }
}

/** True for an `OriginUnavailableError`, across bundles (the runner script imports a copy). */
export function isOriginUnavailable(err: unknown): err is OriginUnavailableError {
  return (
    err instanceof OriginUnavailableError ||
    (err instanceof Error && err.name === 'OriginUnavailableError')
  );
}

/** The zero-record error, carrying the pages the current trace saw. */
export function zeroRecordsError(): Error {
  return new Error(`refresh returned 0 records: ${describeTrace(traces.getStore())}`);
}

/** One line, no parentheses or pipes (the Daily numbers row and its parser split on those). */
export function describeTrace(trace: OriginTrace | undefined): string {
  if (!trace?.first) return 'no origin page seen';
  const first = describePage(trace.first);
  if (trace.pages <= 1 || !trace.last) return first;
  return `${first}; ${trace.pages} pages, last ${describePage(trace.last)}`;
}

function describePage(page: OriginPage): string {
  const bytes =
    page.bytes === null
      ? 'no length'
      : `${page.bytesAtLeast ? '>=' : ''}${formatBytes(page.bytes)}`;
  return `${page.method.toUpperCase()} ${page.status} ${bytes} ${page.shape} from ${page.url}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function describeResponse(method: string, url: string, res: Response): Promise<OriginPage> {
  const page: OriginPage = {
    method,
    url,
    status: res.status,
    bytes: null,
    bytesAtLeast: false,
    shape: 'no body',
  };
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && res.headers.get('content-length') !== null) page.bytes = length;
  if (!res.body) return page;
  const { prefix, complete } = await peek(res.clone().body);
  if (page.bytes === null) {
    page.bytes = prefix.byteLength;
    page.bytesAtLeast = !complete;
  }
  page.shape = describeBody(new TextDecoder().decode(prefix), complete);
  return page;
}

/** Up to PEEK bytes of a cloned body, then cancel it so the clone buffers nothing more. */
async function peek(
  body: ReadableStream<Uint8Array> | null,
): Promise<{ prefix: Uint8Array; complete: boolean }> {
  if (!body) return { prefix: new Uint8Array(0), complete: true };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let seen = 0;
  let complete = false;
  try {
    while (seen < PEEK) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      chunks.push(value);
      seen += value.byteLength;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    else reader.releaseLock();
  }
  const out = new Uint8Array(Math.min(seen, PEEK));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, out.byteLength - offset);
    if (take <= 0) break;
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { prefix: out, complete: complete && seen <= PEEK };
}

/** Top-level keys or array length when the whole body was a JSON page; else its first chars. */
export function describeBody(text: string, complete: boolean): string {
  const trimmed = text.trim();
  if (trimmed === '') return 'empty body';
  if (complete && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return `array[${parsed.length}]`;
      if (parsed && typeof parsed === 'object') {
        const keys = Object.keys(parsed);
        if (keys.length === 0) return 'keys none';
        const shown = keys.slice(0, MAX_KEYS).join(',');
        return `keys ${shown}${keys.length > MAX_KEYS ? `,+${keys.length - MAX_KEYS}` : ''}`;
      }
    } catch {
      // not JSON after all: fall through to the text form
    }
  }
  const flat = trimmed.replace(/\s+/g, ' ').replace(/[()|]/g, '_');
  return `text ${flat.length > TEXT_CHARS ? `${flat.slice(0, TEXT_CHARS)}…` : flat}`;
}
