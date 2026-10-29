import { describe, expect, it } from 'vitest';
import {
  errorLineOf,
  errorLinesNote,
  errorLogQuery,
  foldErrorLines,
} from '../src/lib/error-lines.js';

const line = (level: string, message: string, shape: 'source' | 'text' = 'source'): unknown =>
  shape === 'source'
    ? { $metadata: { level, service: 'faceless-api' }, source: { level, message, requestId: 'r1' } }
    : { $metadata: { level, message } };

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
          line('error', 'TypeError: x is not a function'),
          line('error', 'D1_ERROR: too many SQL variables'),
          line('info', 'ignored'),
          line('error', 'TypeError: x is not a function'),
        ],
      },
    };
    const folded = foldErrorLines(body);
    expect(folded.lines).toBe(3);
    expect(folded.top).toEqual([
      { message: 'TypeError: x is not a function', n: 2 },
      { message: 'D1_ERROR: too many SQL variables', n: 1 },
    ]);
    expect(errorLinesNote(folded)).toBe(
      'worker errors 24h: 3 (TypeError: x is not a function ×2, D1_ERROR: too many SQL variables ×1)',
    );
    expect(errorLinesNote(foldErrorLines({ result: { events: [] } }))).toBe('worker errors 24h: 0');
  });
});
