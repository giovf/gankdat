import { describe, expect, it } from 'vitest';
import {
  errorLineOf,
  errorLinesNote,
  errorLogQuery,
  foldErrorLines,
  routeFamily,
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
    // Request events without a response status still fold by route, the status unknown.
    expect(folded.routes).toEqual([
      { route: 'GET /v1/data/uk-company-profiles ?', n: 1 },
      { route: 'POST /mcp ?', n: 1 },
    ]);
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
      'worker errors 24h: 7 (TypeError: x is not a function ×2, a ×1, b ×1 +1 more; requests: GET /v1/data/uk-company-profiles ? ×1, POST /mcp ? ×1)',
    );
    expect(errorLinesNote(foldErrorLines({ result: { events: [] } }))).toBe('worker errors 24h: 0');
  });

  /** The invocation event as Workers Logs keeps it (worker logs run 4, 2026-10-30 18:44). */
  const request = (method: string, path: string, status: number, requestId: string): unknown => ({
    $workers: {
      event: {
        request: { method, url: `https://gankdat.com${path}` },
        path: path.split('?')[0],
        response: { status },
      },
      outcome: 'ok',
    },
    $metadata: {
      level: 'error',
      service: 'faceless-api',
      requestId,
      trigger: `${method} ${path}`,
      message: `${method} https://gankdat.com${path}`,
      type: 'cf-worker-event',
    },
  });

  it('folds a path family to its first three segments', () => {
    expect(routeFamily('/stats/uk-trademark-journal/class/16')).toBe(
      '/stats/uk-trademark-journal/class/*',
    );
    expect(routeFamily('/feeds/uk-sanctions/regime/Russia.xml')).toBe(
      '/feeds/uk-sanctions/regime/*',
    );
    expect(routeFamily('/v1/data/uk-planning')).toBe('/v1/data/uk-planning');
    expect(routeFamily('/mcp')).toBe('/mcp');
    expect(routeFamily('/')).toBe('/');
  });

  it('names the 5xx request events by method, path family and status, most frequent first', () => {
    const events = [
      request('GET', '/stats/uk-trademark-journal/class/16', 503, 'a1'),
      request('GET', '/stats/uk-trademark-journal/class/16', 503, 'a2'),
      request('GET', '/stats/uk-trademark-journal/class/24?x=1', 503, 'a3'),
      request('GET', '/v1/data/uk-planning', 503, 'a4'),
      request('GET', '/v1/data/uk-planning', 503, 'a5'),
      request('POST', '/mcp', 500, 'a6'),
      line('error', 'D1_ERROR: internal error; reference = 9f', 'source', 'a6'),
      request('GET', '/token', 500, 'a7'),
      // A flat dotted key carries the status too.
      {
        '$workers.event.response.status': '502',
        $metadata: {
          level: 'error',
          requestId: 'a8',
          message: 'GET https://gankdat.com/x402/data/eu-ted',
        },
      },
    ];
    const folded = foldErrorLines({ result: { events } });
    expect(folded.lines).toBe(9);
    expect(folded.requests).toBe(8);
    expect(folded.routes).toEqual([
      { route: 'GET /stats/uk-trademark-journal/class/* 503', n: 3 },
      { route: 'GET /v1/data/uk-planning 503', n: 2 },
      { route: 'GET /token 500', n: 1 },
      { route: 'GET /x402/data/eu-ted 502', n: 1 },
      { route: 'POST /mcp 500', n: 1 },
    ]);
    // The named counts add up to the line total: 1 thrown + 8 requests.
    const named =
      folded.messages.reduce((n, m) => n + m.n, 0) + folded.routes.reduce((n, r) => n + r.n, 0);
    expect(named).toBe(folded.lines);
    expect(folded.messages[0]!.paths).toEqual([{ path: '/mcp', n: 1 }]);
    expect(errorLinesNote(folded)).toBe(
      'worker errors 24h: 9 (D1_ERROR: internal error; reference = … ×1; requests: GET /stats/uk-trademark-journal/class/* 503 ×3, GET /v1/data/uk-planning 503 ×2, GET /token 500 ×1 +2 more)',
    );
    // Requests only: the clause opens with them.
    expect(errorLinesNote(foldErrorLines({ result: { events: events.slice(0, 1) } }))).toBe(
      'worker errors 24h: 1 (requests: GET /stats/uk-trademark-journal/class/* 503 ×1)',
    );
  });
});
