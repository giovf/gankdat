import { describe, expect, it } from 'vitest';
import {
  WAVE_LOG_SERVICE,
  parseWaveLogEvents,
  waveLogNote,
  waveLogQuery,
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
});

describe('parseWaveLogEvents', () => {
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

describe('waveLogNote', () => {
  it('names each queried source’s newest line with its age, or the reason none was read', () => {
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
      'wave log: uk-care-locations n/a (HTTP 403 (token lacks Workers Observability Read)); uk-tenders no log line in 24 h; uk-trademark-journal [error] Error: D1_ERROR / killed 11 min ago (2 lines)',
    );
  });

  it('says when no source was stale and when the runner left nothing', () => {
    expect(waveLogNote({ date: '2026-10-09', sources: {} }, NOW)).toBe('wave log: no stale source');
    expect(waveLogNote(null, NOW)).toBe('wave log: n/a (no runner result)');
  });
});
