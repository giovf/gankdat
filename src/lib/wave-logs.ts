/**
 * Wave log reading (gankdat `wave-log-reading`, 2026-10-09): the GitHub runner asks Workers
 * observability for the last log lines the Worker wrote about a source whose refresh left no
 * `ok` row, so a wave killed at the 15-minute Cron Trigger limit — which writes no refresh_log
 * row at all (uk-trademark-journal 10-05..10-08, twice guessed at through the relay) — leaves a
 * trace the Daily numbers row can carry. Pure: the request body, the tolerant parse of the query
 * response and the one-line reading; the POST itself lives in scripts/runner-refresh.mjs.
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

export interface WaveLogResult {
  /** Query outcome: HTTP status, or 0 for a network failure. */
  status: number;
  events: WaveLogEvent[];
  /** Why no events could be read (non-200, scope missing, unparseable body); null on success. */
  reason: string | null;
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
  return {
    queryId: `wave-log-${needle}`,
    timeframe: { from: nowMs - hours * 60 * 60 * 1000, to: nowMs },
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

const ageText = (fromIso: string, nowMs: number): string => {
  const ms = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(ms)) return '';
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(0, Math.round(ms / 60_000))} min ago` : `${h.toFixed(1)} h ago`;
};

/**
 * The Daily numbers row's `wave log:` reading from the runner's `dist/wave-logs.json`: for each
 * source queried, its newest log line (≤ 80 chars) and age, or why nothing could be read.
 */
export function waveLogNote(file: WaveLogFile | null, nowMs: number): string {
  if (!file) return 'wave log: n/a (no runner result)';
  const slugs = Object.keys(file.sources).sort();
  if (slugs.length === 0) return 'wave log: no stale source';
  const parts = slugs.map((slug) => {
    const r = file.sources[slug];
    if (!r) return `${slug} n/a`;
    if (r.reason) return `${slug} n/a (${r.reason})`;
    const last = r.events[0];
    if (!last) return `${slug} no log line in 24 h`;
    const age = last.at ? ` ${ageText(last.at, nowMs)}` : '';
    return `${slug} [${last.level}] ${last.message.slice(0, 80)}${age} (${r.events.length} lines)`;
  });
  return `wave log: ${parts.join('; ')}`.replace(/\|/g, '/');
}
