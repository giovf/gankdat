import { describe, expect, it } from 'vitest';
import {
  LOG_PAGE_LIMIT,
  logReadLine,
  pageStats,
  readLogEvents,
  storedCountLine,
  storedCountOf,
  storedCountQuery,
  withStoredCount,
  type LogQuery,
} from '../src/lib/log-read.js';
import { readErrorLines } from '../src/lib/error-lines.js';

const HOUR = 3_600_000;
const query: LogQuery = {
  queryId: 'q',
  timeframe: { from: 0, to: 4 * HOUR },
  parameters: { datasets: ['cloudflare-workers'], filters: [], calculations: [], groupBys: [] },
  view: 'events',
  limit: 50,
};
const ev = (id: string): unknown => ({ $metadata: { id, level: 'error', message: `m ${id}` } });
const page = (events: unknown[], count: number, abr?: number): unknown => ({
  success: true,
  result: {
    events: { count, events },
    statistics: {
      rows_read: 1000,
      bytes_read: 1,
      elapsed: 0.1,
      ...(abr ? { abr_level: abr } : {}),
    },
  },
});

describe('complete Workers Logs read', () => {
  it('reads the match count, rows scanned and ABR level of a response (empty level is 1)', () => {
    expect(pageStats(page([], 7))).toEqual({ matched: 7, rowsRead: 1000, abrLevel: 1 });
    expect(pageStats(page([], 7, 0)).abrLevel).toBe(1);
    expect(pageStats(page([], 7, 4)).abrLevel).toBe(4);
    expect(pageStats({ result: { events: [] } })).toEqual({
      matched: null,
      rowsRead: null,
      abrLevel: 1,
    });
  });

  it('one full-data page under the limit is complete in one request', async () => {
    const sent: LogQuery[] = [];
    const read = await readLogEvents(
      (q) => {
        sent.push(q);
        return Promise.resolve(page([ev('a'), ev('b')], 2));
      },
      query,
      50,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.limit).toBe(50);
    expect(read.events).toHaveLength(2);
    expect(read.stats.partial).toEqual([]);
    expect(logReadLine(read.stats)).toBe(
      'log read: 2 returned of 2 matched — complete (1 request, 1 window, ABR level 1, 1,000 rows scanned)',
    );
  });

  it('follows the cursor past one page with offset = the last $metadata.id', async () => {
    const all = Array.from({ length: LOG_PAGE_LIMIT + 3 }, (_, i) => ev(`e${i}`));
    const sent: LogQuery[] = [];
    const read = await readLogEvents(
      (q) => {
        sent.push(q);
        const start = q.offset === undefined ? 0 : Number(String(q.offset).slice(1)) + 1;
        return Promise.resolve(page(all.slice(start, start + Number(q.limit)), all.length));
      },
      query,
      6000,
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]!.offset).toBe(`e${LOG_PAGE_LIMIT - 1}`);
    expect(sent[1]!.offsetDirection).toBe('next');
    expect(read.events).toHaveLength(LOG_PAGE_LIMIT + 3);
    expect(read.stats.matched).toBe(LOG_PAGE_LIMIT + 3);
    expect(read.stats.partial).toEqual([]);
  });

  it('halves a window answered from sampled data and reads both halves, newest first', async () => {
    const sent: LogQuery[] = [];
    const read = await readLogEvents(
      (q) => {
        sent.push(q);
        const span = q.timeframe.to - q.timeframe.from;
        if (span > 2 * HOUR) return Promise.resolve(page([ev('sampled')], 1, 4));
        return Promise.resolve(page([ev(`w${q.timeframe.from}`)], 1));
      },
      query,
      50,
    );
    expect(sent.map((q) => [q.timeframe.from, q.timeframe.to])).toEqual([
      [0, 4 * HOUR],
      [2 * HOUR, 4 * HOUR],
      [0, 2 * HOUR],
    ]);
    // The sampled answer's events are dropped; the two full-data halves are kept.
    expect(read.events.map((e) => (e as { $metadata: { id: string } }).$metadata.id)).toEqual([
      `w${2 * HOUR}`,
      'w0',
    ]);
    expect(read.stats).toMatchObject({ windows: 2, requests: 3, abrLevel: 1, matched: 2 });
    expect(read.stats.partial).toEqual([]);
  });

  it('names sampling it could not narrow away, and a limit that cut the read', async () => {
    const sampled = await readLogEvents(() => Promise.resolve(page([], 0, 8)), query, 50, 5);
    expect(sampled.stats.abrLevel).toBe(8);
    expect(logReadLine(sampled.stats)).toContain(
      'PARTIAL: ABR level 8: answered from sampled data, lines can be missing',
    );
    const cut = await readLogEvents(
      (q) =>
        Promise.resolve(
          page(
            Array.from({ length: Number(q.limit) }, (_, i) => ev(`c${i}`)),
            12_000,
          ),
        ),
      query,
      50,
    );
    expect(cut.events).toHaveLength(50);
    expect(logReadLine(cut.stats)).toContain('50 returned of 12,000 matched — PARTIAL: limit 50');
  });

  it('measures a read against the store count, not the page-bound events.count (run 37)', async () => {
    // Live shape 2026-11-18: limit 5 answered count 5 while the store held 177.
    const read = await readLogEvents(
      (q) =>
        Promise.resolve(
          q.timeframe.to - q.timeframe.from > 2 * HOUR
            ? page([], 0, 3)
            : page(
                Array.from({ length: Number(q.limit) }, (_, i) => ev(`${q.timeframe.from}-${i}`)),
                Number(q.limit),
              ),
        ),
      query,
      5,
    );
    const stored = { count: 177, sampleInterval: 1, abrLevel: 1 };
    const line = logReadLine(withStoredCount(read.stats, stored));
    expect(line).toContain('5 returned of 177 matched — PARTIAL: limit 5 reached');
    expect(line).toContain('ABR level 1 after halving (the whole window was answered at level 3');
    // A read that stopped short with no other reason is named from the store's count.
    const quiet = await readLogEvents(() => Promise.resolve(page([ev('a')], 1)), query, 50);
    expect(withStoredCount(quiet.stats, stored).partial).toEqual([
      'the store counts 177 for the same filters',
    ]);
    expect(withStoredCount(quiet.stats, { ...stored, count: 1 }).partial).toEqual([]);
    // Run 38's shape: one full-data page of exactly the limit, the page's count equal to the limit.
    const full = await readLogEvents(
      (q) =>
        Promise.resolve(
          page(
            Array.from({ length: Number(q.limit) }, (_, i) => ev(`f${i}`)),
            Number(q.limit),
          ),
        ),
      query,
      5,
    );
    expect(logReadLine(withStoredCount(full.stats, stored))).toContain(
      '5 returned of 177 matched — PARTIAL: limit 5 reached',
    );
    expect(storedCountLine({ count: 177, sampleInterval: 1, abrLevel: 4 })).toContain(
      'estimated: the count was answered at ABR level 4',
    );
  });

  it('says completeness is unknown when the response carries no count', async () => {
    const read = await readLogEvents(() => Promise.resolve({ result: { events: [] } }), query, 50);
    expect(logReadLine(read.stats)).toContain('matched n/a — no match count in the response');
  });

  it('asks the store for a count with the same filters and reads its sample interval', () => {
    const count = storedCountQuery({ ...query, offset: 'x' });
    expect(count.view).toBe('calculations');
    expect(count.limit).toBeUndefined();
    expect(count.offset).toBeUndefined();
    expect((count.parameters as { calculations: unknown[] }).calculations).toEqual([
      { operator: 'count' },
    ]);
    const body = (sampleInterval: number): unknown => ({
      result: { calculations: [{ aggregates: [{ count: 12000, sampleInterval, value: 12000 }] }] },
    });
    expect(storedCountLine(storedCountOf(body(1)))).toBe(
      'log store: 12,000 events, sample interval 1 (nothing dropped at ingest)',
    );
    expect(storedCountLine(storedCountOf(body(100)))).toContain(
      'SAMPLED AT INGEST: sample interval 100',
    );
    expect(storedCountLine(storedCountOf({ result: {} }), 'HTTP 400')).toBe(
      'log store: count n/a (HTTP 400)',
    );
  });

  it('readErrorLines heads the report with the read and marks a partial reading in the row', async () => {
    const fetcher = ((_url: string, init: { body: string }) => {
      const q = JSON.parse(init.body) as LogQuery;
      const body =
        q.view === 'calculations'
          ? { result: { calculations: [{ aggregates: [{ count: 1, sampleInterval: 1 }] }] } }
          : page([ev('a')], 1, 2);
      return Promise.resolve(new Response(JSON.stringify(body)));
    }) as unknown as typeof fetch;
    const reading = await readErrorLines('https://example.test/q', {}, 24 * HOUR, 24, fetcher);
    expect(reading.report[0]).toMatch(
      /^log read: 1 returned of \d+ matched — PARTIAL: ABR level 2/,
    );
    expect(reading.report[1]).toMatch(/^log store: 1 events, sample interval 1/);
    expect(reading.note).toMatch(/^worker errors 24h: 1 \(m a ×1; partial read: ABR level 2/);

    const refused = (() =>
      Promise.resolve(new Response('no', { status: 403 }))) as unknown as typeof fetch;
    await expect(readErrorLines('https://example.test/q', {}, 1, 24, refused)).rejects.toThrow(
      'HTTP 403 (token lacks Workers Observability Read)',
    );
  });
});
