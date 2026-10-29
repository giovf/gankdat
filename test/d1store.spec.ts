import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BACKFILL_BUDGET_MS,
  BACKFILL_HANDOVER_MS,
  BACKFILL_UPDATE_SQL,
  backfillClock,
  facetsClock,
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
  it('writes the parent stats before the facets, so a spent budget still leaves a blob', async () => {
    const source: DataSource = {
      ...makeSource('d1-facet-first'),
      stats: {
        date: { field: 'listed_on', title: 'Listed by month' },
        groupBy: [{ field: 'classification', title: 'By classification' }],
        facets: [
          {
            segment: 'kind',
            field: 'classification',
            title: 'By kind',
            values: [{ value: 'Firm', label: 'Firms' }],
            groupBy: [],
          },
        ],
      },
    };
    const realNow = facetsClock.now;
    try {
      let calls = 0;
      facetsClock.now = (): number => Date.now() + (calls++ === 0 ? 0 : 300_000); // spent at once
      await refreshD1Source(env, source);
      const cached = await readSourceStats(env, 'd1-facet-first');
      expect(cached?.stats.total).toBe(RECORDS.length);
      expect(cached?.stats.facets).toEqual([
        { segment: 'kind', field: 'classification', title: 'By kind', pages: [] },
      ]);
    } finally {
      facetsClock.now = realNow;
    }
  });

  const twoFacets = (slug: string): DataSource => ({
    ...makeSource(slug),
    stats: {
      date: { field: 'listed_on', title: 'Listed by month' },
      groupBy: [{ field: 'country', title: 'By country' }],
      facets: ['kind', 'kind-again'].map((segment) => ({
        segment,
        field: 'classification',
        title: 'By kind',
        values: [
          { value: 'Firm', label: 'Firms' },
          { value: 'Individual', label: 'People' },
          { value: 'Vessel', label: 'Vessels' },
        ],
        groupBy: [{ field: 'country', title: 'By country' }],
      })),
    },
  });
  type FacetRead = { at: string; facets: Record<string, [string, number, string | undefined][]> };
  const facetsOf = async (slug: string): Promise<FacetRead> => {
    const cached = await readSourceStats(env, slug);
    const facets: FacetRead['facets'] = {};
    for (const facet of cached!.stats.facets ?? []) {
      facets[facet.segment] = facet.pages.map((p) => [p.value, p.total, p.as_of]);
    }
    return { at: cached!.last_refreshed_at, facets };
  };
  const fresh: [string, number, undefined][] = [
    ['Firm', 3, undefined],
    ['Individual', 2, undefined],
    ['Vessel', 1, undefined],
  ];
  const asOf = (at: string): [string, number, string][] => [
    ['Firm', 3, at],
    ['Individual', 2, at],
    ['Vessel', 1, at],
  ];

  it('carries facets past the budget from the previous blob, stalest first', async () => {
    const source = twoFacets('d1-facet-budget');
    // Night 1: both facets fit the budget.
    await refreshD1Source(env, source);
    const night1 = await facetsOf('d1-facet-budget');
    expect(night1.facets).toEqual({ kind: fresh, 'kind-again': fresh });
    const realNow = facetsClock.now;
    // The budget runs out after the first facet: its pages computed, the other facet carried.
    // Clock reads per computed facet: pass start, the budget check, the facet start, the write gap.
    const spendAfterOne = (): void => {
      let calls = 0;
      const base = Date.now();
      facetsClock.now = (): number => base + (calls++ < 4 ? 0 : 300_000);
    };
    try {
      await new Promise((resolve) => setTimeout(resolve, 5)); // a later last_refreshed_at
      spendAfterOne();
      await refreshD1Source(env, source);
      const night2 = await facetsOf('d1-facet-budget');
      expect(night2.at > night1.at).toBe(true);
      // Nothing had been carried before, so spec order decides: kind fresh, kind-again as of night 1.
      expect(night2.facets).toEqual({ kind: fresh, 'kind-again': asOf(night1.at) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      spendAfterOne();
      await refreshD1Source(env, source);
      const night3 = await facetsOf('d1-facet-budget');
      // Stalest first: kind-again (night 1) is recomputed; kind is now as of night 2.
      expect(night3.facets).toEqual({ kind: asOf(night2.at), 'kind-again': fresh });
    } finally {
      facetsClock.now = realNow;
    }
  });

  it('a facet pass that dies keeps the facets written so far; the failure path does not clobber them', async () => {
    const source = twoFacets('d1-facet-partial');
    await refreshD1Source(env, source);
    const night1 = await facetsOf('d1-facet-partial');
    expect(night1.facets).toEqual({ kind: fresh, 'kind-again': fresh });
    const realGap = facetsClock.writeGapMs;
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Every computed facet is written at once, and the pass dies after the first one — the
      // shape of a wave the platform kills or an aggregation that throws mid-pass.
      facetsClock.writeGapMs = 0;
      facetsClock.afterFacet = (segment): void => {
        if (segment === 'kind') throw new Error('killed after the first facet');
      };
      await refreshD1Source(env, source); // the refresh itself succeeds: stats are best-effort
      const night2 = await facetsOf('d1-facet-partial');
      expect(night2.at > night1.at).toBe(true);
      // kind is tonight's; the facet the pass never reached is carried from night 1.
      expect(night2.facets).toEqual({ kind: fresh, 'kind-again': asOf(night1.at) });
    } finally {
      facetsClock.writeGapMs = realGap;
      facetsClock.afterFacet = null;
    }
  });

  it('a facet whose statements fail is carried and the pass goes on to the next facet', async () => {
    const source = twoFacets('d1-facet-fail');
    try {
      // Night 1, no previous blob: the failing facet has no pages, the other is computed.
      facetsClock.beforeFacet = (segment): void => {
        if (segment === 'kind') throw new Error('D1_ERROR: statement timed out');
      };
      await refreshD1Source(env, source);
      const night1 = await facetsOf('d1-facet-fail');
      expect(night1.facets).toEqual({ kind: [], 'kind-again': fresh });
      // Night 2, it fails again: still no pages, the other facet fresh.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await refreshD1Source(env, source);
      expect((await facetsOf('d1-facet-fail')).facets).toEqual({ kind: [], 'kind-again': fresh });
      // Night 3, it computes: both facets, nothing carried.
      facetsClock.beforeFacet = null;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await refreshD1Source(env, source);
      const night3 = await facetsOf('d1-facet-fail');
      expect(night3.facets).toEqual({ kind: fresh, 'kind-again': fresh });
      // Night 4, every facet fails: each is carried from night 3.
      facetsClock.beforeFacet = (): void => {
        throw new Error('D1_ERROR: internal error');
      };
      await new Promise((resolve) => setTimeout(resolve, 5));
      await refreshD1Source(env, source);
      const night4 = await facetsOf('d1-facet-fail');
      expect(night4.at > night3.at).toBe(true);
      expect(night4.facets).toEqual({ kind: asOf(night3.at), 'kind-again': asOf(night3.at) });
    } finally {
      facetsClock.beforeFacet = null;
    }
  });

  it('groups records under every element of an array or comma-list facet field in one scan per statement', async () => {
    const records = [
      { tags: ['a', 'b'], classes: '09,35', country: 'GBR', published: '2026-01-05' },
      { tags: ['b'], classes: '35', country: 'ESP', published: '2026-02-05' },
      { tags: 'c', classes: '42, 09', country: 'GBR', published: '2026-02-10' },
      { classes: 'he said "09"', country: 'FRA', published: '2026-03-01' },
    ];
    const source: DataSource = {
      ...makeSource('d1-facet-elements', records),
      stats: {
        date: { field: 'published', title: 'By month' },
        groupBy: [{ field: 'country', title: 'By country' }],
        facets: [
          {
            segment: 'tag',
            field: 'tags',
            title: 'By tag',
            values: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
              { value: 'c', label: 'C' },
            ],
            groupBy: [],
          },
          {
            segment: 'class',
            field: 'classes',
            title: 'By class',
            values: [
              { value: '09', label: 'Class 9' },
              { value: '35', label: 'Class 35' },
              { value: '42', label: 'Class 42' },
              { value: '99', label: 'Class 99' },
            ],
            date: { field: 'published', title: 'By month' },
            groupBy: [{ field: 'country', title: 'By country', limit: 1 }],
          },
        ],
      },
    };
    await refreshD1Source(env, source);
    const cached = await readSourceStats(env, 'd1-facet-elements');
    const [tag, cls] = cached!.stats.facets!;
    expect(tag!.pages.map((p) => [p.value, p.label, p.total])).toEqual([
      ['a', 'A', 1],
      ['b', 'B', 2],
      ['c', 'C', 1],
    ]);
    expect(cls!.pages.map((p) => [p.value, p.total])).toEqual([
      ['09', 2],
      ['35', 2],
      ['42', 1],
      ['99', 0],
    ]);
    const nine = cls!.pages[0]!;
    expect(nine.monthly).toEqual({
      title: 'By month',
      buckets: [
        { month: '2026-01', count: 1 },
        { month: '2026-02', count: 1 },
      ],
    });
    expect(nine.groups).toEqual([{ title: 'By country', rows: [{ value: 'GBR', count: 2 }] }]);
    expect(cls!.pages[3]).toEqual({
      value: '99',
      label: 'Class 99',
      total: 0,
      monthly: null,
      groups: [],
    });
  });
});
