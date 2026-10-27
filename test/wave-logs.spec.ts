import { describe, expect, it } from 'vitest';
import {
  WAVE_LOG_SERVICE,
  cronClock,
  dropNoise,
  isNoiseLine,
  parseWaveInvocations,
  parseWaveLogEvents,
  pickReading,
  waveInvocationQuery,
  waveInvocationText,
  waveLogNote,
  waveLogQuery,
  waveWindowQuery,
  invocationLinesQuery,
  type WaveLogEvent,
  type WaveLogFile,
} from '../src/lib/wave-logs';

// Wave log reading (2026-10-09): the runner's query body, the tolerant parse of the Workers
// observability response and the one-line reading the Daily numbers row carries.

const NOW = Date.parse('2026-10-09T06:30:00Z');

describe('waveLogQuery', () => {
  it('asks for the last 24 h of this Worker’s lines mentioning the source, newest first', () => {
    const q = waveLogQuery('uk-trademark-journal', NOW);
    expect(q.view).toBe('events');
    expect(q.limit).toBe(20);
    expect(q.timeframe).toEqual({ from: NOW - 24 * 3_600_000, to: NOW });
    const p = q.parameters as { filters: { value: string }[]; needle: { value: string } };
    expect(p.filters[0]?.value).toBe(WAVE_LOG_SERVICE);
    expect(p.needle.value).toBe('uk-trademark-journal');
  });

  it('reads an explicit window — the wave’s own minutes — with the same filters', () => {
    const end = Date.parse('2026-10-27T06:08:23Z');
    const q = waveWindowQuery('uk-trademark-journal', end - 177_328, end);
    expect(q.timeframe).toEqual({ from: end - 177_328, to: end });
    expect(q.limit).toBe(20);
    const p = q.parameters as { filters: { value: string }[]; needle: { value: string } };
    expect(p.filters[0]?.value).toBe(WAVE_LOG_SERVICE);
    expect(p.needle.value).toBe('uk-trademark-journal');
    const all = waveWindowQuery(null, end - 177_328, end, 10);
    expect(all.limit).toBe(10);
    expect('needle' in (all.parameters as Record<string, unknown>)).toBe(false);
  });
});

describe('invocationLinesQuery', () => {
  it('filters on the invocation’s requestId with no needle', () => {
    const q = invocationLinesQuery('8be812928b8f1d5fcce96daa8cdae80a', 1, 2);
    const p = q.parameters as { filters: { key: string; value: string }[] };
    expect(p.filters.map((f) => [f.key, f.value])).toEqual([
      ['$metadata.service', WAVE_LOG_SERVICE],
      ['$metadata.requestId', '8be812928b8f1d5fcce96daa8cdae80a'],
    ]);
    expect('needle' in (q.parameters as Record<string, unknown>)).toBe(false);
    expect(q.timeframe).toEqual({ from: 1, to: 2 });
  });
});

describe('parseWaveLogEvents', () => {
  it('reads a JSON console.log kept as the `source` object (the live shape, 2026-10-27)', () => {
    const rows = [
      {
        source: {
          retained: false,
          level: 'warn',
          event: 'stats_precompute_failed',
          source: 'uk-trademark-journal',
          reason: 'D1_ERROR: D1 DB exceeded its CPU time limit and was reset.',
        },
        dataset: 'cloudflare-workers',
        timestamp: 1793081298567,
        $workers: { eventType: 'scheduled', event: { cron: '5 6 * * *' } },
        $metadata: { requestId: '8be812928b8f1d5fcce96daa8cdae80a', service: 'faceless-api' },
      },
      {
        source: { level: 'info', message: 'GET https://gankdat.com/wp-login.php' },
        dataset: 'cloudflare-workers',
        timestamp: 1793081298156,
        $metadata: { requestId: '981a2289eb3cb7389584c127eb5b0c6e', service: 'faceless-api' },
      },
    ];
    const events = parseWaveLogEvents({ result: { events: { events: rows } } });
    expect(events.map((e) => [e.at, e.level, e.message])).toEqual([
      [
        '2026-10-27T06:08:18.567Z',
        'warn',
        'event=stats_precompute_failed source=uk-trademark-journal reason=D1_ERROR: D1 DB exceeded its CPU time limit and was reset. retained=false',
      ],
      ['2026-10-27T06:08:18.156Z', 'info', 'GET https://gankdat.com/wp-login.php'],
    ]);
  });

  it('reads the Query Builder shape and leads a structured line with its event and source', () => {
    const body = {
      success: true,
      result: {
        events: {
          count: 2,
          events: [
            {
              $metadata: {
                level: 'log',
                message: JSON.stringify({
                  level: 'info',
                  event: 'tmj_window',
                  source: 'uk-trademark-journal',
                  elapsed_ms: 812345,
                  download_budget_spent: true,
                  issues: 3,
                }),
                service: 'faceless-api',
                timestamp: Date.parse('2026-10-09T06:12:04Z'),
              },
            },
            {
              $metadata: {
                level: 'error',
                message: 'Error: D1_ERROR: too many SQL variables',
                timestamp: Date.parse('2026-10-09T06:18:40Z'),
              },
            },
          ],
        },
      },
    };
    const events = parseWaveLogEvents(body);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      at: '2026-10-09T06:18:40.000Z',
      level: 'error',
      message: 'Error: D1_ERROR: too many SQL variables',
    });
    expect(events[1]?.message).toBe(
      'event=tmj_window source=uk-trademark-journal elapsed_ms=812345 download_budget_spent=true issues=3',
    );
  });

  it('tolerates a flat events array, microsecond timestamps and skips empty lines', () => {
    const events = parseWaveLogEvents({
      result: [
        { timestamp: 1791_000_000_000_000, message: '  spaced   out  ' },
        { timestamp: '1791000000000', message: '' },
      ],
    });
    expect(events).toEqual([
      { at: '2026-10-03T04:00:00.000Z', level: 'log', message: 'spaced out' },
    ]);
  });

  it('returns nothing for an unknown body', () => {
    expect(parseWaveLogEvents(null)).toEqual([]);
    expect(parseWaveLogEvents({ success: false, errors: [{ code: 10000 }] })).toEqual([]);
  });
});

// Cron outcome reading (2026-10-17): the 10-16 metrics job (run 38866226604) showed the slug
// search returning only request lines and @x402/hono's Ajv warning, and the journal's wave left
// no line at all — so the noise is dropped and the wave's own invocation is read.
describe('noise and the line to read', () => {
  const line = (message: string, at = '2026-10-16T06:10:00.000Z', level = 'log'): WaveLogEvent => ({
    at,
    level,
    message,
  });

  it('knows the invocation request line and the x402 Bazaar warning as noise, nothing else', () => {
    expect(isNoiseLine('GET https://gankdat.com/stats/uk-trademark-journal')).toBe(true);
    expect(isNoiseLine('POST https://gankdat.com/x402/data/uk-planning')).toBe(true);
    expect(
      isNoiseLine(
        'x402: Route "GET /x402/data/uk-trademark-journal" has an invalid bazaar extension: Schema validation failed: Code generation from strings disallowed for this context',
      ),
    ).toBe(true);
    expect(isNoiseLine('GET /stats/uk-trademark-journal/class/25 503')).toBe(false);
    expect(isNoiseLine('event=refresh_failed source=uk-trademark-journal')).toBe(false);
    expect(isNoiseLine('Error: D1_ERROR: too many SQL variables')).toBe(false);
  });

  it('reads the newest structured refresh event ahead of a newer bare line, never noise', () => {
    const events = [
      line(
        'x402: Route "GET /x402/data/uk-planning" has an invalid bazaar extension: Schema validation failed: Code generation from strings disallowed for this context',
        '2026-10-16T09:00:00.000Z',
      ),
      line('GET /stats/uk-trademark-journal/class/25 503', '2026-10-16T08:00:00.000Z', 'error'),
      line(
        'event=refresh_failed source=uk-trademark-journal reason=D1 timeout',
        '2026-10-16T06:12:00.000Z',
      ),
      line('GET https://gankdat.com/data/uk-trademark-journal', '2026-10-16T06:11:00.000Z'),
    ];
    expect(dropNoise(events).map((e) => e.at)).toEqual([
      '2026-10-16T08:00:00.000Z',
      '2026-10-16T06:12:00.000Z',
    ]);
    expect(pickReading(events)?.message).toBe(
      'event=refresh_failed source=uk-trademark-journal reason=D1 timeout',
    );
    expect(pickReading(events.slice(0, 2))?.message).toBe(
      'GET /stats/uk-trademark-journal/class/25 503',
    );
    expect(pickReading([events[0]!, events[3]!])).toBeUndefined();
  });
});

describe('waveInvocationQuery', () => {
  it('asks for the last 26 h of this Worker’s invocations of one Cron Trigger', () => {
    const q = waveInvocationQuery('5 6 * * *', NOW);
    expect(q.queryId).toBe('wave-cron-5-6-');
    expect(q.view).toBe('events');
    expect(q.limit).toBe(5);
    expect(q.timeframe).toEqual({ from: NOW - 26 * 3_600_000, to: NOW });
    const p = q.parameters as { filters: { key: string; value: string }[]; needle?: unknown };
    expect(p.filters).toEqual([
      { key: '$metadata.service', operation: 'eq', value: WAVE_LOG_SERVICE, type: 'string' },
      { key: '$metadata.type', operation: 'eq', value: 'cf-worker-event', type: 'string' },
    ]);
    expect(p.needle).toEqual({ value: '5 6 * * *', isRegex: false, matchCase: true });
  });
});

describe('parseWaveInvocations', () => {
  it('reads nested $workers invocation rows, newest first, and leaves log lines out', () => {
    const body = {
      success: true,
      result: {
        events: {
          count: 3,
          events: [
            {
              $metadata: { service: 'faceless-api', timestamp: Date.parse('2026-10-15T06:05:01Z') },
              $workers: {
                outcome: 'ok',
                wallTimeMs: 812345,
                cpuTimeMs: 2450,
                eventType: 'scheduled',
                event: { cron: '5 6 * * *', scheduledTime: '2026-10-15T06:05:00Z' },
              },
            },
            {
              $metadata: {
                message: 'event=refresh_wave',
                timestamp: Date.parse('2026-10-16T06:05:02Z'),
              },
            },
            {
              $metadata: { service: 'faceless-api', timestamp: Date.parse('2026-10-16T06:05:01Z') },
              $workers: {
                outcome: 'exceededCpu',
                wallTimeMs: '900120',
                event: { cron: '5 6 * * *' },
              },
            },
          ],
        },
      },
    };
    expect(parseWaveInvocations(body, '5 6 * * *')).toEqual([
      {
        at: '2026-10-16T06:05:01.000Z',
        outcome: 'exceededCpu',
        wallTimeMs: 900120,
        cpuTimeMs: null,
        cron: '5 6 * * *',
        requestId: null,
      },
      {
        at: '2026-10-15T06:05:01.000Z',
        outcome: 'ok',
        wallTimeMs: 812345,
        cpuTimeMs: 2450,
        cron: '5 6 * * *',
        requestId: null,
      },
    ]);
  });

  it('tolerates flat dotted keys and drops rows of another cron when the filter was ignored', () => {
    const rows = [
      {
        timestamp: 1791_000_000_000,
        '$workers.outcome': 'canceled',
        '$workers.event.cron': '0 5 * * *',
      },
      { timestamp: 1791_000_000_000, '$workers.outcome': 'exception', '$workers.wallTimeMs': 12 },
    ];
    expect(parseWaveInvocations({ result: rows }, '5 6 * * *')).toEqual([
      {
        at: '2026-10-03T04:00:00.000Z',
        outcome: 'exception',
        wallTimeMs: 12,
        cpuTimeMs: null,
        cron: null,
        requestId: null,
      },
    ]);
    expect(parseWaveInvocations({ result: rows })).toHaveLength(2);
    expect(parseWaveInvocations(null, '5 6 * * *')).toEqual([]);
  });

  it('knows a documented invocation log by its type, reads the cron from its message and ranks a matched cron ahead of an unread one', () => {
    const rows = [
      {
        $metadata: {
          type: 'cf-worker-event',
          message: '5 6 * * *',
          service: 'faceless-api',
          timestamp: Date.parse('2026-10-16T06:05:01Z'),
        },
      },
      {
        $metadata: {
          type: 'cf-worker-event',
          message: 'GET https://gankdat.com/data/uk-tenders',
          timestamp: Date.parse('2026-10-16T06:06:01Z'),
        },
      },
      {
        $metadata: { type: 'cf-worker-event-log', message: '5 6 * * *', timestamp: 1 },
      },
    ];
    // The newer row names no cron (the substring needle also matches another wave's row), so the
    // older row whose cron is this wave's is the one to read (2026-10-22).
    expect(parseWaveInvocations({ result: { events: { events: rows } } }, '5 6 * * *')).toEqual([
      {
        at: '2026-10-16T06:05:01.000Z',
        outcome: 'unknown',
        wallTimeMs: null,
        cpuTimeMs: null,
        cron: '5 6 * * *',
        requestId: null,
      },
      {
        at: '2026-10-16T06:06:01.000Z',
        outcome: 'unknown',
        wallTimeMs: null,
        cpuTimeMs: null,
        cron: null,
        requestId: null,
      },
    ]);
    // Without a cron to match, newest first as before.
    expect(parseWaveInvocations({ result: { events: { events: rows } } }).map((i) => i.at)).toEqual(
      ['2026-10-16T06:06:01.000Z', '2026-10-16T06:05:01.000Z'],
    );
  });
});

describe('waveInvocationText', () => {
  it('renders the wave’s clock, outcome, wall time and age, or why there is none', () => {
    expect(cronClock('5 6 * * *')).toBe('06:05');
    expect(cronClock('0 5 * * *')).toBe('05:00');
    expect(cronClock('*/5 * * * *')).toBe('*/5 * * * *');
    const inv = {
      at: '2026-10-09T06:20:01.000Z',
      outcome: 'exceededCpu',
      wallTimeMs: 900120,
      cpuTimeMs: null,
      cron: '5 6 * * *',
      requestId: null,
    };
    expect(
      waveInvocationText({ cron: '5 6 * * *', status: 200, invocations: [inv], reason: null }, NOW),
    ).toBe('wave 06:05: exceededCpu 900.1s 10 min ago');
    expect(
      waveInvocationText(
        {
          cron: '5 6 * * *',
          status: 200,
          invocations: [{ ...inv, wallTimeMs: null }],
          reason: null,
        },
        NOW,
      ),
    ).toBe('wave 06:05: exceededCpu 10 min ago');
    // A row that named no cron may be another wave's (the 10-21 reading, 2026-10-22): say so.
    expect(
      waveInvocationText(
        {
          cron: '0 5 * * *',
          status: 200,
          invocations: [{ ...inv, outcome: 'ok', wallTimeMs: 79024, cron: null }],
          reason: null,
        },
        NOW,
      ),
    ).toBe('wave 05:00: ok 79.0s 10 min ago (cron unread)');
    expect(
      waveInvocationText({ cron: '0 5 * * *', status: 200, invocations: [], reason: null }, NOW),
    ).toBe('wave 05:00: no invocation logged in 26 h');
    expect(
      waveInvocationText(
        { cron: '0 5 * * *', status: 403, invocations: [], reason: 'HTTP 403' },
        NOW,
      ),
    ).toBe('wave 05:00: n/a (HTTP 403)');
  });
});

describe('waveLogNote', () => {
  it('leads with the wave’s invocation, reads a refresh event past the noise and counts both', () => {
    const file: WaveLogFile = {
      date: '2026-10-16',
      sources: {
        'uk-trademark-journal': {
          status: 200,
          reason: null,
          lines: 6,
          events: [
            {
              at: '2026-10-09T06:25:00.000Z',
              level: 'error',
              message: 'GET /stats/uk-trademark-journal/class/25 503',
            },
            {
              at: '2026-10-09T06:12:04.000Z',
              level: 'log',
              message: 'event=hash_backfill source=uk-trademark-journal',
            },
          ],
          wave: {
            cron: '5 6 * * *',
            status: 200,
            reason: null,
            invocations: [
              {
                at: '2026-10-09T06:20:01.000Z',
                outcome: 'exceededCpu',
                wallTimeMs: 900120,
                cpuTimeMs: null,
                cron: '5 6 * * *',
                requestId: null,
              },
            ],
          },
        },
        'uk-planning': {
          status: 200,
          reason: null,
          lines: 7,
          events: [],
          wave: { cron: '0 5 * * *', status: 200, reason: null, invocations: [] },
        },
        'uk-insolvency': { status: 200, reason: null, lines: 0, events: [], wave: null },
      },
    };
    expect(waveLogNote(file, NOW)).toBe(
      'wave log: uk-insolvency no log line in 24 h; uk-planning wave 05:00: no invocation logged in 26 h, no log line in 24 h (7 noise lines); uk-trademark-journal wave 06:05: exceededCpu 900.1s 10 min ago, [log] event=hash_backfill source=uk-trademark-journal 18 min ago (2 of 6 lines)',
    );
  });

  it('names each queried source’s refresh event (else newest line) with its age, or the reason none was read', () => {
    const file: WaveLogFile = {
      date: '2026-10-09',
      sources: {
        'uk-trademark-journal': {
          status: 200,
          reason: null,
          events: [
            { at: '2026-10-09T06:18:40.000Z', level: 'error', message: 'Error: D1_ERROR | killed' },
            { at: '2026-10-09T06:12:04.000Z', level: 'log', message: 'event=tmj_window' },
          ],
        },
        'uk-care-locations': {
          status: 403,
          reason: 'HTTP 403 (token lacks Workers Observability Read)',
          events: [],
        },
        'uk-tenders': { status: 200, reason: null, events: [] },
      },
    };
    expect(waveLogNote(file, NOW)).toBe(
      'wave log: uk-care-locations n/a (HTTP 403 (token lacks Workers Observability Read)); uk-tenders no log line in 24 h; uk-trademark-journal [log] event=tmj_window 18 min ago (2 lines)',
    );
  });

  it('says when no source was stale and when the runner left nothing', () => {
    expect(waveLogNote({ date: '2026-10-09', sources: {} }, NOW)).toBe('wave log: no stale source');
    expect(waveLogNote(null, NOW)).toBe('wave log: n/a (no runner result)');
  });
});
