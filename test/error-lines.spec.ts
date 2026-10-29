import { describe, expect, it } from 'vitest';
import {
  errorLineOf,
  errorLinesNote,
  errorLogQuery,
  foldErrorLines,
} from '../src/lib/error-lines.js';

const line = (
  level: string,
  message: string,
  shape: 'source' | 'text' = 'source',
  requestId = 'r1',
): unknown =>
  shape === 'source'
    ? { $metadata: { level, service: 'faceless-api', requestId }, source: { level, message } }
    : { $metadata: { level, message, requestId } };

describe('worker error lines', () => {
  it('builds the Query Builder body filtered to the service and the error level', () => {
    const body = errorLogQuery(1_000_000, 24, 500) as {
      timeframe: { from: number; to: number };
      parameters: { filters: { key: string; value: string }[] };
      limit: number;
    };
    expect(body.timeframe).toEqual({ from: 1_000_000 - 24 * 3_600_000, to: 1_000_000 });
    expect(body.parameters.filters.map((f) => `${f.key}=${f.value}`)).toEqual([
      '$metadata.service=faceless-api',
      '$metadata.level=error',
    ]);
    expect(body.limit).toBe(500);
  });

  it('reads the handler message from the source object, a text line, or a JSON text line', () => {
    expect(errorLineOf(line('error', 'D1_ERROR: no such table'))).toBe('D1_ERROR: no such table');
    expect(errorLineOf(line('error', 'boom', 'text'))).toBe('boom');
    expect(
      errorLineOf({ $metadata: { level: 'error', message: '{"level":"error","message":"x y"}' } }),
    ).toBe('x y');
    expect(errorLineOf(line('warn', 'not an error'))).toBeNull();
    expect(errorLineOf('nope')).toBeNull();
  });

  it('folds a response by message, most frequent first, and writes the clause', () => {
    const body = {
      result: {
        events: [
          line('error', 'TypeError: x is not a function', 'source', 'r1'),
          line('error', 'POST https://gankdat.com/mcp', 'source', 'r1'),
          line('error', 'D1_ERROR: internal error; reference = abc123', 'source', 'r2'),
          line(
            'error',
            'GET https://gankdat.com/v1/data/uk-company-profiles?company_number=1',
            'source',
            'r2',
          ),
          line('info', 'ignored'),
          line('error', 'TypeError: x is not a function', 'source', 'r3'),
          line('error', 'a'),
          line('error', 'b'),
        ],
      },
    };
    const folded = foldErrorLines(body);
    expect(folded.lines).toBe(7);
    expect(folded.requests).toBe(2);
    expect(folded.messages.map((m) => m.n)).toEqual([2, 1, 1, 1]);
    expect(folded.messages[0]!.paths).toEqual([{ path: '/mcp', n: 1 }]);
    expect(folded.messages.find((m) => m.message.startsWith('D1_ERROR'))).toEqual({
      message: 'D1_ERROR: internal error; reference = …',
      n: 1,
      paths: [{ path: '/v1/data/uk-company-profiles', n: 1 }],
    });
    expect(folded.top).toEqual([
      { message: 'TypeError: x is not a function', n: 2 },
      { message: 'a', n: 1 },
      { message: 'b', n: 1 },
    ]);
    expect(errorLinesNote(folded)).toBe(
      'worker errors 24h: 7 (TypeError: x is not a function ×2, a ×1, b ×1 +1 more)',
    );
    expect(errorLinesNote(foldErrorLines({ result: { events: [] } }))).toBe('worker errors 24h: 0');
  });
});
