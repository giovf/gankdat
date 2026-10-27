/**
 * Wave log reading (gankdat `wave-log-reading`, 2026-10-09): the GitHub runner asks Workers
 * observability for the last log lines the Worker wrote about a source whose refresh left no
 * `ok` row, so a wave killed at the 15-minute Cron Trigger limit — which writes no refresh_log
 * row at all (uk-trademark-journal 10-05..10-08, twice guessed at through the relay) — leaves a
 * trace the Daily numbers row can carry. Pure: the request body, the tolerant parse of the query
 * response and the one-line reading; the POST itself lives in scripts/runner-refresh.mjs.
 *
 * Cron outcome reading (gankdat `wave-log-cron-outcome-reading`, 2026-10-17): the slug search's
 * first real test (10-16) returned only noise — request lines and @x402/hono's Ajv warning
 * (workerd forbids code generation; the Bazaar extension is valid) — and the journal's 06:05 wave
 * left no line at all, the silent night the 10-09 build said to read from the invocation itself.
 * So a second query asks for the wave's own cron invocation (`$workers.event.cron`), whose
 * `$workers.outcome` (ok / exceededCpu / exceededMemory / canceled / exception) and wall time
 * name what the platform did to the wave even when the Worker wrote nothing; noise lines are
 * dropped before the newest line is picked and a structured refresh event wins over a bare line.
 *
 * What the invocation query actually reads (gankdat `wave-log-cron-query-blind`, 2026-10-22, from the
 * 10-18..10-22 metrics job logs): the query is not blind — on 10-21 it returned two `ok` rows (wall
 * 79.8 s and 79.0 s) and on 10-22 one (104.0 s), each row's timestamp being the invocation's END
 * (10-21: 05:02:15.7 − 79.8 s = 05:00:56, the second uk-planning's first error line was written).
 * But it is not complete either: on 10-18, 10-19 and 10-20 the same query answered 200 with no row
 * at all while the wave's D1 rows exist, and on 10-22 the 05:15 wave left no row where 10-21's did.
 * So `no invocation logged` stays the wording (the progress marker is the reading of a silent wave),
 * and because the needle is a substring — `0 5 * * *` is inside `30 5 * * *` and `50 5 * * *` —
 * and the live rows carried no readable cron (10-21's second row ended 79 s after the 05:15 wave
 * began), a row whose cron could not be read is reported as `(cron unread)` and ranks behind one
 * whose cron matches; the runner prints the first raw row whenever a parsed row lacks its cron.
 */

/** Workers observability Query Builder endpoint, relative to the account. */
export const WAVE_LOG_QUERY_PATH = '/workers/observability/telemetry/query';
/** Worker name in wrangler.jsonc (`$metadata.service` in Workers Logs). */
export const WAVE_LOG_SERVICE = 'faceless-api';
export const WAVE_LOG_LIMIT = 20;

export interface WaveLogEvent {
  /** ISO timestamp of the log line. */
  at: string;
  level: string;
  /** The log line, whitespace collapsed; a structured log's `event` and `source` come first. */
  message: string;
}

/** One cron invocation of the Worker as Workers Logs records it (an invocation log, not a line). */
export interface WaveInvocation {
  /** ISO timestamp of the invocation. */
  at: string;
  /** `$workers.outcome`: ok, exceededCpu, exceededMemory, canceled, exception, unknown … */
  outcome: string;
  /** `$workers.wallTimeMs`, when carried. */
  wallTimeMs: number | null;
  /** `$workers.cpuTimeMs`, when carried. */
  cpuTimeMs: number | null;
  /** `$workers.event.cron`, when carried. */
  cron: string | null;
}

/** The invocation query for a source's wave, next to its slug search. */
export interface WaveInvocationResult {
  /** The wave's Cron Trigger (store.ts CRON_BY_WAVE). */
  cron: string;
  status: number;
  invocations: WaveInvocation[];
  reason: string | null;
}

export interface WaveLogResult {
  /** Query outcome: HTTP status, or 0 for a network failure. */
  status: number;
  /** Log lines mentioning the slug, newest first; noise (request lines, library warnings) already dropped. */
  events: WaveLogEvent[];
  /** Why no events could be read (non-200, scope missing, unparseable body); null on success. */
  reason: string | null;
  /** How many lines the slug search returned before the noise was dropped (absent in older files). */
  lines?: number;
  /** The wave's own cron invocation; absent for a runner-fed or lookup source (no wave) or an older file. */
  wave?: WaveInvocationResult | null;
}

export interface WaveLogFile {
  date: string;
  sources: Record<string, WaveLogResult>;
}

/** Request body for the last `hours` of log lines mentioning `needle`, newest first. */
export function waveLogQuery(
  needle: string,
  nowMs: number,
  hours = 24,
  limit = WAVE_LOG_LIMIT,
): Record<string, unknown> {
  return waveWindowQuery(needle, nowMs - hours * 60 * 60 * 1000, nowMs, limit);
}

/**
 * The same search over an explicit window — the wave's own minutes (2026-10-27, gankdat
 * `sitemap-5xx-verify`): the 24 h read returns the newest lines first and the API hands back ten,
 * so a relay round or a crawler naming the slug buries a wave's warn line within minutes of it.
 * The runner reads the window of the invocation it found (`WaveInvocation.at`, less its wall
 * time), where the Worker's own lines for the source stand alone.
 */
export function waveWindowQuery(
  needle: string,
  fromMs: number,
  toMs: number,
  limit = WAVE_LOG_LIMIT,
): Record<string, unknown> {
  return {
    queryId: `wave-log-${needle}`,
    timeframe: { from: fromMs, to: toMs },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$metadata.service', operation: 'eq', value: WAVE_LOG_SERVICE, type: 'string' },
      ],
      needle: { value: needle, isRegex: false, matchCase: false },
      calculations: [],
      groupBys: [],
    },
    view: 'events',
    limit,
  };
}

export const WAVE_INVOCATION_HOURS = 26;
export const WAVE_INVOCATION_LIMIT = 5;

/** `$metadata.type` of an invocation log (Workers Logs docs, relay cf-workers-logs-fields-2026-10-17). */
export const INVOCATION_LOG_TYPE = 'cf-worker-event';

/**
 * Request body for the last `hours` of invocations of the Cron Trigger `cron`, newest first.
 * The documented shape only: an invocation log is `$metadata.type = cf-worker-event` and a cron
 * invocation's message is the schedule itself (`5 6 * * *`), so the cron is the needle; the
 * `$workers.event.cron` match happens in parseWaveInvocations, never as a filter key the API
 * might reject.
 */
export function waveInvocationQuery(
  cron: string,
  nowMs: number,
  hours = WAVE_INVOCATION_HOURS,
  limit = WAVE_INVOCATION_LIMIT,
): Record<string, unknown> {
  return {
    queryId: `wave-cron-${cron.replace(/[^0-9]+/g, '-')}`,
    timeframe: { from: nowMs - hours * 60 * 60 * 1000, to: nowMs },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters: [
        { key: '$metadata.service', operation: 'eq', value: WAVE_LOG_SERVICE, type: 'string' },
        { key: '$metadata.type', operation: 'eq', value: INVOCATION_LOG_TYPE, type: 'string' },
      ],
      needle: { value: cron, isRegex: false, matchCase: true },
      calculations: [],
      groupBys: [],
    },
    view: 'events',
    limit,
  };
}

/**
 * Lines the slug search returns that say nothing about the wave: the invocation's own request
 * line (`GET https://gankdat.com/…`) and @x402/hono's per-isolate Bazaar validation warning
 * (`x402: Route "…" has an invalid bazaar extension: … Code generation from strings disallowed`).
 */
export const NOISE_LINE = /^(x402: Route |(GET|POST|HEAD|PUT|PATCH|DELETE|OPTIONS) https?:\/\/)/;

export const isNoiseLine = (message: string): boolean => NOISE_LINE.test(message);

/** The events worth reading, in their order. */
export function dropNoise(events: WaveLogEvent[]): WaveLogEvent[] {
  return events.filter((e) => !isNoiseLine(e.message));
}

/** A `console.log(JSON.stringify({ event, source, … }))` line as eventOf rendered it. */
const isStructured = (e: WaveLogEvent): boolean => /^event=/.test(e.message);

/** The line to read for a source: its newest structured refresh event, else its newest line. */
export function pickReading(events: WaveLogEvent[]): WaveLogEvent | undefined {
  const kept = dropNoise(events);
  return kept.find(isStructured) ?? kept[0];
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

function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isRecord(v) || Array.isArray(v)) return JSON.stringify(v);
  return '';
}

function timestampOf(e: Record<string, unknown>, meta: Record<string, unknown>): string {
  const raw = meta.timestamp ?? e.timestamp ?? e.$timestamp ?? meta.$timestamp;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof n === 'number' && Number.isFinite(n)) {
    return new Date(n > 1e14 ? n / 1000 : n).toISOString();
  }
  if (typeof n === 'string' && !Number.isNaN(Date.parse(n))) return new Date(n).toISOString();
  return '';
}

/** One event from the query response, whatever of the three known shapes the line took. */
function eventOf(raw: unknown): WaveLogEvent | null {
  if (!isRecord(raw)) return null;
  const meta = isRecord(raw.$metadata) ? raw.$metadata : {};
  const level = text(meta.level ?? raw.level ?? 'log');
  let message = text(meta.message ?? raw.message);
  // A console.log(JSON.stringify({ level, event, source, … })) line arrives as its JSON text;
  // lead with the fields a wave writes so the reading says what happened, then the rest.
  if (message.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(message);
      if (isRecord(parsed)) {
        const lead = ['event', 'source', 'reason', 'elapsed_ms', 'download_budget_spent']
          .filter((k) => k in parsed)
          .map((k) => `${k}=${text(parsed[k])}`);
        const rest = Object.keys(parsed)
          .filter(
            (k) =>
              ![
                'event',
                'source',
                'reason',
                'elapsed_ms',
                'download_budget_spent',
                'level',
              ].includes(k),
          )
          .map((k) => `${k}=${text(parsed[k])}`);
        message = [...lead, ...rest].join(' ');
      }
    } catch {
      /* not JSON — keep the text */
    }
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (!message) return null;
  return { at: timestampOf(raw, meta), level, message };
}

/** Events in the response body, newest first; `[]` when the body holds none. */
export function parseWaveLogEvents(body: unknown): WaveLogEvent[] {
  const result = isRecord(body) && 'result' in body ? body.result : body;
  const rows = firstArray(result) ?? [];
  return rows
    .map(eventOf)
    .filter((e): e is WaveLogEvent => e !== null)
    .sort((a, b) => b.at.localeCompare(a.at));
}

function numberOf(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Nested read: `$workers.event.cron` from `{ $workers: { event: { cron } } }` or a flat dotted key. */
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

const CRON_SHAPE = /^\S+ \S+ \S+ \S+ \S+$/;
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * One invocation from the query response; null for a row that is a log line, not an invocation.
 * A row is an invocation when it carries `$workers.outcome` or is typed `cf-worker-event`; its
 * cron is `$workers.event.cron` or, for a cron invocation, the message itself.
 */
function invocationOf(raw: unknown): WaveInvocation | null {
  if (!isRecord(raw)) return null;
  const meta = isRecord(raw.$metadata) ? raw.$metadata : {};
  const outcome = nonEmpty(fieldOf(raw, ['$workers', 'outcome'])) ?? nonEmpty(meta.outcome);
  const type = nonEmpty(meta.type) ?? nonEmpty(raw.type);
  if (!outcome && type !== INVOCATION_LOG_TYPE) return null;
  const message = nonEmpty(meta.message) ?? nonEmpty(raw.message) ?? '';
  const cron =
    nonEmpty(fieldOf(raw, ['$workers', 'event', 'cron'])) ??
    (CRON_SHAPE.test(message.trim()) ? message.trim() : null);
  return {
    at: timestampOf(raw, meta),
    outcome: outcome ?? 'unknown',
    wallTimeMs: numberOf(fieldOf(raw, ['$workers', 'wallTimeMs'])),
    cpuTimeMs: numberOf(fieldOf(raw, ['$workers', 'cpuTimeMs'])),
    cron,
  };
}

/**
 * Invocations in the response body, newest first; rows that carry a cron other than `cron`
 * (a filter the API ignored) are left out, rows without one are kept but rank behind every row
 * whose cron matches (2026-10-22: the needle is a substring and the live rows carried no readable
 * cron, so a cron-less row may belong to another wave).
 */
export function parseWaveInvocations(body: unknown, cron?: string): WaveInvocation[] {
  const result = isRecord(body) && 'result' in body ? body.result : body;
  const rows = firstArray(result) ?? [];
  const known = (i: WaveInvocation): number => (cron && i.cron === cron ? 0 : 1);
  return rows
    .map(invocationOf)
    .filter((i): i is WaveInvocation => i !== null && (!cron || !i.cron || i.cron === cron))
    .sort((a, b) => known(a) - known(b) || b.at.localeCompare(a.at));
}

/** `HH:MM` of a daily cron (`5 6 * * *` → `06:05`); the cron itself when it is not one. */
export function cronClock(cron: string): string {
  const [minute, hour] = cron.trim().split(/\s+/);
  if (!/^\d{1,2}$/.test(minute ?? '') || !/^\d{1,2}$/.test(hour ?? '')) return cron;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const ageText = (fromIso: string, nowMs: number): string => {
  const ms = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return '';
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(0, Math.round(ms / 60_000))} min ago` : `${h.toFixed(1)} h ago`;
};

/**
 * `wave 06:05: exceededCpu 900.0s 18.3 h ago` — what the platform did to the source's wave; the
 * timestamp is the invocation's end. `(cron unread)` when the row named no cron, so it may be
 * another wave's (2026-10-22).
 */
export function waveInvocationText(wave: WaveInvocationResult, nowMs: number): string {
  const head = `wave ${cronClock(wave.cron)}:`;
  if (wave.reason) return `${head} n/a (${wave.reason})`;
  const last = wave.invocations[0];
  // "logged", not "fired": on 2026-10-16 the query returned no line from any cron wave, for
  // sources that verifiably refreshed, and on 10-18..10-20 no row for a wave whose D1 rows exist,
  // so an empty answer says nothing about the trigger.
  if (!last) return `${head} no invocation logged in ${WAVE_INVOCATION_HOURS} h`;
  const wall = last.wallTimeMs === null ? '' : ` ${(last.wallTimeMs / 1000).toFixed(1)}s`;
  const age = last.at ? ` ${ageText(last.at, nowMs)}` : '';
  const unread = last.cron === null ? ' (cron unread)' : '';
  return `${head} ${last.outcome}${wall}${age}${unread}`;
}

/**
 * The Daily numbers row's `wave log:` reading from the runner's `dist/wave-logs.json`: for each
 * source queried, its wave's last cron invocation (outcome and wall time) and its newest readable
 * log line (≤ 80 chars, a structured refresh event first) with age, or why nothing could be read.
 */
export function waveLogNote(file: WaveLogFile | null, nowMs: number): string {
  if (!file) return 'wave log: n/a (no runner result)';
  const slugs = Object.keys(file.sources).sort();
  if (slugs.length === 0) return 'wave log: no stale source';
  const parts = slugs.map((slug) => {
    const r = file.sources[slug];
    if (!r) return `${slug} n/a`;
    const wave = r.wave ? `${waveInvocationText(r.wave, nowMs)}, ` : '';
    if (r.reason) return `${slug} ${wave}n/a (${r.reason})`;
    const kept = dropNoise(r.events);
    const total = r.lines ?? r.events.length;
    const last = pickReading(kept);
    if (!last) {
      const noise = total > 0 ? ` (${total} noise lines)` : '';
      return `${slug} ${wave}no log line in 24 h${noise}`;
    }
    const age = last.at ? ` ${ageText(last.at, nowMs)}` : '';
    const count = total > kept.length ? `${kept.length} of ${total} lines` : `${kept.length} lines`;
    return `${slug} ${wave}[${last.level}] ${last.message.slice(0, 80)}${age} (${count})`;
  });
  return `wave log: ${parts.join('; ')}`.replace(/\|/g, '/');
}
