import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BACKFILL_BUDGET_MS,
  BACKFILL_HANDOVER_MS,
  BACKFILL_UPDATE_SQL,
  backfillClock,
  hash53,
  queryD1Source,
  refreshD1Source,
} from '../src/sources/d1store';
import { readSourceStats } from '../src/sources/cache';
import { computeStats } from '../src/lib/stats';
import { applyQuery, buildQuerySchema } from '../src/sources/query';
import type { DataSource } from '../src/sources/types';

// Semantics parity: a D1-backed source must answer every query exactly like
// the KV path's applyQuery — including non-ASCII case folding (record_lc is
// JS-lowercased at ingest) and boolean params (strict equality).

const RECORDS = [
  {
    name: 'Alpha Corp',
    classification: 'Firm',
    country: 'USA',
    amount: 100,
    listed_on: '2026-01-05',
    flagged: true,
    website: 'https://alpha.example',
  },
  {
    name: 'beta LLC',
    classification: 'Firm',
    country: 'GBR',
    amount: 250,
    listed_on: '2026-02-10',
    flagged: false,
    website: '',
  },
  {
    name: 'Charlie Person',
    classification: 'Individual',
    country: 'USA',
    amount: null,
    listed_on: '2026-02-20',
    flagged: false,
  },
  {
    name: 'Delta Vessel',
    classification: 'Vessel',
    country: 'PAN',
    amount: 75,
    listed_on: null,
    flagged: true,
  },
  {
    name: 'Epsilon Firm',
    classification: 'Firm',
    country: 'ESP',
    amount: 300,
    listed_on: '2026-03-01',
    flagged: false,
  },
  // Accented name (item 10): uppercase non-ASCII must fold like JS toLowerCase.
  {
    name: 'José Müller SL',
    classification: 'Individual',
    country: 'ESP',
    amount: 500,
    listed_on: '2026-04-01',
    flagged: true,
  },
];

function makeSource(slug: string, records: unknown[] = RECORDS): DataSource {
  return {
    slug,
    title: 'D1 test source',
    description: 'test-only',
    storage: 'd1',
    recordSchema: z.looseObject({}),
    queryParams: z.object({
      name: z.string().optional(),
      classification: z.string().optional(),
      country: z.string().optional(),
      amount_min: z.coerce.number().optional(),
      amount_max: z.coerce.number().optional(),
      listed_on_after: z.iso.date().optional(),
      listed_on_before: z.iso.date().optional(),
      // Boolean param (item 11): parsed to a real boolean so both engines
      // compare strictly. z.coerce.boolean would make "false" truthy.
      flagged: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
      amount_present: z.stringbool().optional(),
      listed_on_present: z.stringbool().optional(),
      website_present: z.stringbool().optional(),
    }),
    stats: {
      date: { field: 'listed_on', title: 'Listed by month' },
      groupBy: [{ field: 'classification', title: 'By classification' }],
    },
    refresh: { cron: '0 5 * * *', cacheTtlSeconds: 60 },
    fetchFresh: () => Promise.resolve(records),
  };
}

const QUERIES: Record<string, string>[] = [
  {},
  { name: 'alpha' },
  { name: 'ALPHA' },
  { classification: 'firm' },
  { q: 'usa' },
  { q: 'person' },
  { amount_min: '100' },
  { amount_max: '100' },
  { amount_min: '80', amount_max: '260' },
  { listed_on_after: '2026-02-01' },
  { listed_on_before: '2026-02-10' },
  { listed_on_after: '2026-02-10', listed_on_before: '2026-02-20' },
  { classification: 'Firm', amount_min: '200' },
  { name: 'josé' }, // accented, lowercase needle vs uppercase-É record (item 10)
  { name: 'MÜLLER' }, // uppercase non-ASCII needle
  { flagged: 'true' }, // boolean param parity (item 11)
  { flagged: 'false' },
  { amount_present: 'true' }, // _present parity: null number
  { amount_present: 'false' },
  { listed_on_present: 'false' }, // null string
  { website_present: 'true' }, // '' and missing key are absent
  { website_present: 'false' },
  { website_present: 'false', classification: 'firm' },
  { per_page: '2' },
  { per_page: '2', page: '2' },
  { per_page: '2', page: '3' },
  { name: 'zzz-no-match' },
];

describe('d1store', () => {
  it('answers every query with the same result as applyQuery (parity)', async () => {
    const source = makeSource('d1-parity');
    await refreshD1Source(env, source);
    const schema = buildQuerySchema(source);
    for (const raw of QUERIES) {
      const parsed = schema.parse(raw);
      const viaJs = applyQuery(RECORDS, parsed);
      const viaSql = await queryD1Source(env, source, parsed);
      expect(viaSql.page, JSON.stringify(raw)).toEqual(viaJs);
    }
  });

  it('flips generations atomically and drops old rows', async () => {
    const source = makeSource('d1-swap');
    await refreshD1Source(env, source);
    const smaller = RECORDS.slice(0, 2);
    await refreshD1Source(env, { ...source, fetchFresh: () => Promise.resolve(smaller) });

    const parsed = buildQuerySchema(source).parse({});
    const result = await queryD1Source(env, source, parsed);
    expect(result.page.total).toBe(2);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM source_records WHERE source_slug = 'd1-swap'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('keeps the previous generation when a refresh returns 0 records', async () => {
    const source = makeSource('d1-empty');
    await refreshD1Source(env, source);
    await expect(
      refreshD1Source(env, { ...source, fetchFresh: () => Promise.resolve([]) }),
    ).rejects.toThrow('0 records');

    const parsed = buildQuerySchema(source).parse({});
    const result = await queryD1Source(env, source, parsed);
    expect(result.page.total).toBe(RECORDS.length);
  });

  it('precomputes stats at refresh matching the JS aggregation', async () => {
    const source = makeSource('d1-stats');
    await refreshD1Source(env, source);
    // Stats are computed once at refresh and cached in KV; /stats reads this.
    const cached = await readSourceStats(env, 'd1-stats');
    expect(cached).not.toBeNull();
    // Ties in group counts have no canonical order in the JS engine (insertion
    // order); normalize both sides to (count desc, value asc) before comparing.
    const canonical = (
      stats: ReturnType<typeof computeStats>,
    ): ReturnType<typeof computeStats> => ({
      ...stats,
      groups: stats.groups.map((group) => ({
        ...group,
        rows: [...group.rows].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
      })),
    });
    expect(canonical(cached!.stats)).toEqual(canonical(computeStats(RECORDS, source.stats)));
  });

  it('does not refresh on query when the source is not loaded (503 path)', async () => {
    const source = makeSource('d1-cold');
    const parsed = buildQuerySchema(source).parse({});
    // No prior refresh → no meta row → must throw, never trigger a cold-start.
    await expect(queryD1Source(env, source, parsed)).rejects.toThrow(/not been loaded/);
  });

  it('self-heals after a mid-refresh crash left orphan rows at the target generation', async () => {
    const source = makeSource('d1-orphan');
    await refreshD1Source(env, source); // generation 1 committed

    // Simulate a crash after partial insert at generation 2: meta stays at 1,
    // orphan rows linger at generation 2.
    await env.DB.prepare(
      "INSERT INTO source_records (source_slug, generation, seq, search, record) VALUES ('d1-orphan', 2, 0, 'orphan', '{}')",
    ).run();

    // Next refresh recomputes generation 2 and must sweep the orphan first
    // (else a PK collision would throw and wedge the dataset forever).
    await refreshD1Source(env, source);
    const parsed = buildQuerySchema(source).parse({});
    const result = await queryD1Source(env, source, parsed);
    expect(result.page.total).toBe(RECORDS.length);
  });
});

// Delta refresh (cloudflare-usage-breakdown, 2026-10-04): a source with stable ids
// is refreshed in place — only changed rows rewritten, new ids appended, vanished
// ids deleted — instead of a whole new generation a night (D1 bills rows written).
type Rec = (typeof RECORDS)[number];
function makeIdSource(slug: string, records: Rec[]): DataSource {
  return { ...makeSource(slug, records), idOf: (r: unknown) => (r as Rec).name };
}
const countRows = async (slug: string): Promise<number> =>
  (
    await env.DB.prepare('SELECT COUNT(*) AS n FROM source_records WHERE source_slug = ?1')
      .bind(slug)
      .first<{ n: number }>()
  )?.n ?? 0;
const metaOf = (slug: string) =>
  env.DB.prepare('SELECT generation, total FROM source_meta WHERE source_slug = ?1')
    .bind(slug)
    .first<{ generation: number; total: number }>();

describe('d1store delta refresh', () => {
  it('rewrites only what changed, keeps the generation and feeds the changes', async () => {
    const source = makeIdSource('d1-delta', RECORDS);
    await refreshD1Source(env, source);
    expect((await metaOf('d1-delta'))?.generation).toBe(1);

    // Day 2: beta changed, Charlie removed, Zeta added; the rest untouched.
    const day2: Rec[] = [
      RECORDS[0],
      { ...RECORDS[1], amount: 999 },
      ...RECORDS.slice(3),
      { ...RECORDS[4], name: 'Zeta Holdings', country: 'NLD' },
    ];
    await refreshD1Source(env, { ...source, fetchFresh: () => Promise.resolve(day2) });

    const meta = await metaOf('d1-delta');
    expect(meta).toEqual({ generation: 1, total: day2.length });
    expect(await countRows('d1-delta')).toBe(day2.length);
    const schema = buildQuerySchema(source);
    for (const raw of QUERIES) {
      const parsed = schema.parse(raw);
      const viaSql = await queryD1Source(env, source, parsed);
      // Row order is by seq: the appended row sorts last, like the JS engine's input order.
      expect(viaSql.page, JSON.stringify(raw)).toEqual(applyQuery(day2, parsed));
    }
    const changes = await env.DB.prepare(
      "SELECT change, record_id, record FROM source_changes WHERE source_slug = 'd1-delta' ORDER BY change",
    ).all<{ change: string; record_id: string; record: string }>();
    expect(changes.results.map((r) => [r.change, r.record_id])).toEqual([
      ['added', 'Zeta Holdings'],
      ['changed', 'beta LLC'],
      ['removed', 'Charlie Person'],
    ]);
    expect((JSON.parse(changes.results[1].record) as Rec).amount).toBe(999);
    const log = await env.DB.prepare(
      "SELECT message FROM refresh_log WHERE source_slug = 'd1-delta' ORDER BY id DESC LIMIT 1",
    ).first<{ message: string }>();
    expect(log?.message).toBe('delta +1 ~1 -1');

    // Day 3, nothing moved: no change rows, no rewrites.
    await refreshD1Source(env, { ...source, fetchFresh: () => Promise.resolve(day2) });
    const again = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM source_changes WHERE source_slug = 'd1-delta'",
    ).first<{ n: number }>();
    expect(again?.n).toBe(3);
    const quiet = await env.DB.prepare(
      "SELECT message FROM refresh_log WHERE source_slug = 'd1-delta' ORDER BY id DESC LIMIT 1",
    ).first<{ message: string }>();
    expect(quiet?.message).toBe('delta +0 ~0 -0');
  });

  it('backfills the hashes of pre-0014 rows in place, then runs the delta (no full reload)', async () => {
    const source = makeIdSource('d1-nohash', RECORDS);
    await refreshD1Source(env, source);
    await env.DB.prepare(
      "UPDATE source_records SET record_hash = NULL WHERE source_slug = 'd1-nohash' AND seq IN (0, 5)",
    ).run();
    await env.DB.prepare(
      "UPDATE source_records SET record_id = NULL WHERE source_slug = 'd1-nohash' AND seq = 1",
    ).run();
    await refreshD1Source(env, { ...source, fetchFresh: () => Promise.resolve(RECORDS.slice(1)) });
    const meta = await metaOf('d1-nohash');
    // Same generation: the backfill wrote the three missing ids/hashes and the delta removed Alpha.
    expect(meta).toEqual({ generation: 1, total: RECORDS.length - 1 });
    const changes = await env.DB.prepare(
      "SELECT change, record_id FROM source_changes WHERE source_slug = 'd1-nohash' ORDER BY change",
    ).all<{ change: string; record_id: string }>();
    expect(changes.results.map((r) => [r.change, r.record_id])).toEqual([
      ['removed', 'Alpha Corp'],
    ]);
    const unhashed = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM source_records WHERE source_slug = 'd1-nohash' AND (record_hash IS NULL OR record_id IS NULL)",
    ).first<{ n: number }>();
    expect(unhashed?.n).toBe(0);
    // The backfilled hash is the ingest hash: the rows it touched (beta, José Müller) read as unchanged.
    const log = await env.DB.prepare(
      "SELECT status, message FROM refresh_log WHERE source_slug = 'd1-nohash' ORDER BY id DESC LIMIT 1",
    ).first<{ status: string; message: string }>();
    expect(log).toEqual({ status: 'ok', message: 'delta +0 ~0 -1' });
  });

  it('hands a long backfill to the next night with a skipped row, resuming where it stopped', async () => {
    // 2,100 rows: one full backfill page (2,000) and a remainder.
    const many: Rec[] = Array.from({ length: 2_100 }, (_, i) => ({
      ...RECORDS[0],
      name: `Row ${String(i).padStart(4, '0')}`,
      amount: i,
    }));
    const source = makeIdSource('d1-backfill-budget', many);
    await refreshD1Source(env, source);
    await env.DB.prepare(
      "UPDATE source_records SET record_hash = NULL WHERE source_slug = 'd1-backfill-budget'",
    ).run();
    const realNow = backfillClock.now;
    try {
      backfillClock.now = (): number => Date.now() + BACKFILL_BUDGET_MS; // budget spent at once
      await refreshD1Source(env, source);
      const skipped = await env.DB.prepare(
        "SELECT status, records, message FROM refresh_log WHERE source_slug = 'd1-backfill-budget' ORDER BY id DESC LIMIT 1",
      ).first<{ status: string; records: number; message: string }>();
      expect(skipped).toEqual({
        status: 'skipped',
        records: 2_000,
        message: 'hash backfill: 2000 rows hashed, 100 left; delta refresh resumes once complete',
      });
      expect((await metaOf('d1-backfill-budget'))?.generation).toBe(1);
      const left = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM source_records WHERE source_slug = 'd1-backfill-budget' AND record_hash IS NULL",
      ).first<{ n: number }>();
      expect(left?.n).toBe(100);
    } finally {
      backfillClock.now = realNow;
    }
    // Next night: the remaining 100 rows, then the delta in the same run.
    await refreshD1Source(env, source);
    const ok = await env.DB.prepare(
      "SELECT status, message FROM refresh_log WHERE source_slug = 'd1-backfill-budget' ORDER BY id DESC LIMIT 1",
    ).first<{ status: string; message: string }>();
    expect(ok).toEqual({ status: 'ok', message: 'delta +0 ~0 -0' });
    expect((await metaOf('d1-backfill-budget'))?.generation).toBe(1);
    expect(await countRows('d1-backfill-budget')).toBe(2_100);
  });

  it('probes each backfill page by primary key — the plan the 15-minute wave depends on', async () => {
    // 2026-10-09: written as UPDATE … FROM a json_each subquery, SQLite walked the whole
    // generation and scanned the 2,000 entries per row (200 s a page at 162k rows), so wave 7
    // died before the budget check. The entries must be the outer loop, the rows PK lookups.
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${BACKFILL_UPDATE_SQL}`)
      .bind('d1-plan', 1, JSON.stringify([{ q: 0, i: 'a', h: 1 }]))
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail);
    const scanEntries = details.findIndex((d) => /^SCAN j\b/.test(d));
    const probeRows = details.findIndex((d) => /^SEARCH r USING .*seq=\?/.test(d));
    expect(scanEntries, details.join(' | ')).toBeGreaterThanOrEqual(0);
    expect(probeRows, details.join(' | ')).toBeGreaterThan(scanEntries);
    expect(
      details.some((d) => /^SCAN r\b/.test(d)),
      details.join(' | '),
    ).toBe(false);
  });

  it('leaves the delta to the next night when the backfill used minutes of the wave', async () => {
    const source = makeIdSource('d1-backfill-handover', RECORDS);
    await refreshD1Source(env, source);
    await env.DB.prepare(
      "UPDATE source_records SET record_hash = NULL WHERE source_slug = 'd1-backfill-handover'",
    ).run();
    const realNow = backfillClock.now;
    try {
      backfillClock.now = (): number => Date.now() + BACKFILL_HANDOVER_MS; // 3 min gone
      await refreshD1Source(env, {
        ...source,
        fetchFresh: () => Promise.resolve(RECORDS.slice(1)),
      });
    } finally {
      backfillClock.now = realNow;
    }
    const skipped = await env.DB.prepare(
      "SELECT status, records, message FROM refresh_log WHERE source_slug = 'd1-backfill-handover' ORDER BY id DESC LIMIT 1",
    ).first<{ status: string; records: number; message: string }>();
    expect(skipped).toEqual({
      status: 'skipped',
      records: RECORDS.length,
      message: `hash backfill: ${RECORDS.length} rows hashed, 0 left in 180 s; delta refresh runs next night`,
    });
    // Every hash written, nothing else touched: the delta waits for a wave of its own.
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM source_records WHERE source_slug = 'd1-backfill-handover' AND record_hash IS NULL",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect(await metaOf('d1-backfill-handover')).toEqual({ generation: 1, total: RECORDS.length });
    await refreshD1Source(env, { ...source, fetchFresh: () => Promise.resolve(RECORDS.slice(1)) });
    const ok = await env.DB.prepare(
      "SELECT status, message FROM refresh_log WHERE source_slug = 'd1-backfill-handover' ORDER BY id DESC LIMIT 1",
    ).first<{ status: string; message: string }>();
    expect(ok).toEqual({ status: 'ok', message: 'delta +0 ~0 -1' });
  });

  it('writes an error row when the backfill itself throws, so the night is never silent', async () => {
    const source = makeIdSource('d1-backfill-throws', RECORDS);
    await refreshD1Source(env, source);
    await env.DB.prepare(
      "UPDATE source_records SET record_id = NULL WHERE source_slug = 'd1-backfill-throws' AND seq = 2",
    ).run();
    const broken: DataSource = {
      ...source,
      idOf: (r: unknown) => {
        if ((r as Rec).name === RECORDS[2]?.name) throw new Error('id of a stored row blew up');
        return (r as Rec).name;
      },
    };
    await expect(refreshD1Source(env, broken)).rejects.toThrow('id of a stored row blew up');
    const log = await env.DB.prepare(
      "SELECT status, message FROM refresh_log WHERE source_slug = 'd1-backfill-throws' ORDER BY id DESC LIMIT 1",
    ).first<{ status: string; message: string }>();
    expect(log).toEqual({
      status: 'error',
      message: 'hash backfill failed: id of a stored row blew up',
    });
  });

  it('changes nothing when the stream yields 0 records', async () => {
    const source = makeIdSource('d1-delta-empty', RECORDS);
    await refreshD1Source(env, source);
    await expect(
      refreshD1Source(env, { ...source, fetchFresh: () => Promise.resolve([]) }),
    ).rejects.toThrow('0 records');
    expect(await countRows('d1-delta-empty')).toBe(RECORDS.length);
    expect((await metaOf('d1-delta-empty'))?.total).toBe(RECORDS.length);
  });

  it('hash53 is stable and tells records apart', () => {
    expect(hash53('')).toBe(hash53(''));
    expect(hash53('{"a":1}')).toBe(hash53('{"a":1}'));
    expect(hash53('{"a":1}')).not.toBe(hash53('{"a":2}'));
    expect(Number.isSafeInteger(hash53('uk-food-hygiene:123456'))).toBe(true);
  });
});
