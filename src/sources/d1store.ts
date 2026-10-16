import type { StatsFacet, StatsGroupSpec, StatsSpec } from './types';
import type { DataSource } from './types';
import { PRESENT_SUFFIX, type QueryPage } from './query';
import type { ChangeDay, FacetStats, MonthlyTrend, SourceStats, StatsGroup } from '../lib/stats';
import { sortGroupRows } from '../lib/stats';
import { putSourceStats, writeRefreshLog } from './cache';
import { traceOrigin, zeroRecordsError } from './origin';

/** Thrown when a D1 source is queried before cron has loaded it (routes → 503). */
export class SourceNotLoadedError extends Error {
  constructor(slug: string) {
    super(`Source '${slug}' has not been loaded yet`);
    this.name = 'SourceNotLoadedError';
  }
}

// D1-backed source storage (task 44, migration 0007): datasets too large for
// the KV snapshot pattern. Refresh loads a NEW generation of rows then flips
// source_meta, so queries — which always join on the meta generation — never
// see a partial dataset. Filters are translated to SQL with the same
// semantics as query.ts applyQuery: case-insensitive substring for string
// params and `q`, inclusive ranges for _after/_before (date-only ISO string
// compare — a declared constraint on D1 sources) and _min/_max (numeric).

const RESERVED = new Set(['page', 'per_page', 'q']);

/** Rows per INSERT chunk — sized so the JSON bind stays well under D1 limits. */
const INSERT_CHUNK = 2000;
// …and a byte bound: wide rows (uk-charities: 23 fields + a 400-char text, stored three
// ways) blew D1's per-bind size cap ("string or blob too big", 2026-09-20) at 2000 rows.
const INSERT_CHUNK_BYTES = 700_000; // 400k made ~3,600 statements for uk-charities and blew the 15-min trigger

interface SourceMeta {
  generation: number;
  last_refreshed_at: string;
  total: number;
}

async function readMeta(env: CloudflareBindings, slug: string): Promise<SourceMeta | null> {
  return env.DB.prepare(
    'SELECT generation, last_refreshed_at, total FROM source_meta WHERE source_slug = ?1',
  )
    .bind(slug)
    .first<SourceMeta>();
}

/** Lowercased concatenation of the record's string fields, for `q` search. */
function searchText(record: Record<string, unknown>): string {
  return Object.values(record)
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/**
 * Deep copy with every string leaf JS-lowercased (numbers/booleans/null kept).
 * Stored as record_lc so per-field substring filters fold identically to the
 * KV path's JS toLowerCase — SQLite lower() only handles ASCII.
 */
function lowercaseStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.toLowerCase();
  if (Array.isArray(value)) return value.map(lowercaseStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, lowercaseStrings(v)]),
    );
  }
  return value;
}

/**
 * 53-bit string hash (cyrb53): two 32-bit multiplicative mixes folded into one
 * safe integer, so it round-trips through a D1 INTEGER column unchanged. Used
 * for the record id (in memory, so a 600k-row register indexes in ~15 MB of
 * typed arrays instead of a Map of strings) and for the record JSON (stored as
 * record_hash, so the next refresh knows what changed without reading the
 * record text back). Not cryptographic; a collision costs one missed or one
 * spurious change row, never corrupt data.
 */
export function hash53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** One record as the refresh writes it: search text, record, lowercased copy, id, hash. */
interface IngestRow {
  s: string;
  r: unknown;
  l: unknown;
  i: string | null;
  h: number;
}

function ingestRow(source: DataSource, record: unknown, json: string): IngestRow {
  return {
    s: searchText(record as Record<string, unknown>),
    r: record,
    l: lowercaseStrings(record),
    i: source.idOf ? source.idOf(record) : null,
    h: hash53(json),
  };
}

/** Rows per DELETE statement — a single DELETE of ~600k rows (uk-food-hygiene) tripped D1's
 *  per-statement storage timeout ("operation exceeded timeout which caused object to be
 *  reset", 2026-09-20), so old generations are removed in bounded chunks. */
const DELETE_CHUNK = 20_000;

/** Deletes every row of `slug` whose generation is `>=` or `<` the given one, chunk by chunk. */
async function deleteGenerations(
  env: CloudflareBindings,
  slug: string,
  op: '>=' | '<',
  generation: number,
): Promise<void> {
  const stmt = env.DB.prepare(
    `DELETE FROM source_records WHERE rowid IN (
       SELECT rowid FROM source_records WHERE source_slug = ?1 AND generation ${op} ?2 LIMIT ${DELETE_CHUNK}
     )`,
  );
  for (;;) {
    const res = await stmt.bind(slug, generation).run();
    if ((res.meta?.changes ?? 0) < DELETE_CHUNK) return;
  }
}

/** How long change rows are kept. */
const CHANGES_RETENTION_DAYS = 90;

/**
 * Records added / removed / changed rows between two generations of a source
 * (by record_id) into source_changes, stamped with the refresh time. Skipped
 * when the previous generation predates record ids (nothing to compare).
 */
async function recordChanges(
  env: CloudflareBindings,
  slug: string,
  previousGeneration: number,
  generation: number,
  changedAt: string,
): Promise<void> {
  const prevHasIds = await env.DB.prepare(
    'SELECT 1 AS ok FROM source_records WHERE source_slug = ?1 AND generation = ?2 AND record_id IS NOT NULL LIMIT 1',
  )
    .bind(slug, previousGeneration)
    .first<{ ok: number }>();
  if (!prevHasIds) return;
  // search + record_lc ride along so the feed takes the source's own filters
  // (migration 0012) with the same fold as /v1/data.
  const added = `INSERT OR IGNORE INTO source_changes (source_slug, changed_at, change, record_id, record, search, record_lc)
     SELECT n.source_slug, ?3, 'added', n.record_id, n.record, n.search, n.record_lc
     FROM source_records n
     LEFT JOIN source_records o ON o.source_slug = n.source_slug AND o.generation = ?1 AND o.record_id = n.record_id
     WHERE n.source_slug = ?4 AND n.generation = ?2 AND n.record_id IS NOT NULL AND o.record_id IS NULL`;
  const removed = `INSERT OR IGNORE INTO source_changes (source_slug, changed_at, change, record_id, record, search, record_lc)
     SELECT o.source_slug, ?3, 'removed', o.record_id, o.record, o.search, o.record_lc
     FROM source_records o
     LEFT JOIN source_records n ON n.source_slug = o.source_slug AND n.generation = ?2 AND n.record_id = o.record_id
     WHERE o.source_slug = ?4 AND o.generation = ?1 AND o.record_id IS NOT NULL AND n.record_id IS NULL`;
  const changed = `INSERT OR IGNORE INTO source_changes (source_slug, changed_at, change, record_id, record, search, record_lc)
     SELECT n.source_slug, ?3, 'changed', n.record_id, n.record, n.search, n.record_lc
     FROM source_records n
     JOIN source_records o ON o.source_slug = n.source_slug AND o.generation = ?1 AND o.record_id = n.record_id
     WHERE n.source_slug = ?4 AND n.generation = ?2 AND n.record != o.record`;
  for (const sql of [added, removed, changed]) {
    await env.DB.prepare(sql).bind(previousGeneration, generation, changedAt, slug).run();
  }
  await env.DB.prepare(
    "DELETE FROM source_changes WHERE source_slug = ?1 AND changed_at < datetime('now', ?2)",
  )
    .bind(slug, `-${CHANGES_RETENTION_DAYS} days`)
    .run();
}

export interface ChangesQuery {
  since?: string;
  change?: 'added' | 'removed' | 'changed';
  page: number;
  per_page: number;
  /**
   * The source's own query params (+ `q`), already validated against its
   * schema — applied to the changed record with /v1/data semantics, so a
   * watch is one call: `classes=09`, `applicant=acme`, `q=keyword`.
   */
  filters?: Record<string, unknown>;
}

export interface ChangeRow {
  change: string;
  changed_at: string;
  record_id: string;
  record: unknown;
}

/** Page of change rows for a source, newest refresh first (read-only; no refresh). */
export async function queryD1Changes(
  env: CloudflareBindings,
  source: DataSource,
  q: ChangesQuery,
): Promise<{ rows: ChangeRow[]; total: number; last_refreshed_at: string | null }> {
  const meta = await readMeta(env, source.slug);
  const clauses = ['source_slug = ?1'];
  const binds: (string | number)[] = [source.slug];
  if (q.since) {
    clauses.push(`changed_at >= ?${binds.length + 1}`);
    binds.push(q.since.length === 10 ? `${q.since}T00:00:00.000Z` : q.since);
  }
  if (q.change) {
    clauses.push(`change = ?${binds.length + 1}`);
    binds.push(q.change);
  }
  const filters = filterPredicate(q.filters ?? {});
  let next = binds.length + 1;
  for (const clause of filters.clauses) {
    // Anonymous `?` binds → `?n`, numbered on from the feed's own binds.
    clauses.push(clause.replaceAll('?', () => `?${next++}`));
  }
  binds.push(...filters.binds);
  const where = clauses.join(' AND ');
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM source_changes WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = count?.n ?? 0;
  const offset = (q.page - 1) * q.per_page;
  const res = await env.DB.prepare(
    `SELECT change, changed_at, record_id, record FROM source_changes WHERE ${where}
     ORDER BY changed_at DESC, change, record_id LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
  )
    .bind(...binds, q.per_page, offset)
    .all<{ change: string; changed_at: string; record_id: string; record: string }>();
  const rows = (res.results ?? []).map((r) => ({
    change: r.change,
    changed_at: r.changed_at,
    record_id: r.record_id,
    record: JSON.parse(r.record) as unknown,
  }));
  return { rows, total, last_refreshed_at: meta?.last_refreshed_at ?? null };
}

/** Bytes one ingest row adds to a chunk (the record is stored three ways, plus the search text). */
function ingestBytes(entry: IngestRow, json: string): number {
  return json.length * 2 + entry.s.length + (entry.i?.length ?? 0) + 40;
}

/**
 * Refreshes a D1 source. Sources with a stable id (`idOf`) whose stored rows
 * carry record hashes are refreshed IN PLACE (refreshD1Delta): only the rows
 * whose content changed are rewritten, new ids inserted, vanished ids deleted.
 * Everything else — a first load, a source without ids, rows written before
 * migration 0014 — takes the full generation reload (refreshD1Full), which is
 * also what writes the hashes the next delta needs. Called ONLY from the
 * scheduled cron (never inline on a request path — a reload takes seconds to
 * minutes at 100k+ rows and must not be triggerable by an unauthenticated
 * request; queryD1Source and the /stats route read committed state only).
 */
export async function refreshD1Source(
  env: CloudflareBindings,
  source: DataSource,
): Promise<SourceMeta> {
  const start = Date.now();
  const previous = await readMeta(env, source.slug);
  if (previous && source.idOf) {
    let backfill: { done: number; left: number };
    try {
      backfill = await backfillHashes(env, source, previous, start);
    } catch (err) {
      // Outside refreshD1Delta/Full, which write their own rows: without this the night leaves
      // no refresh_log row at all and refreshOne's "already recorded" assumption is wrong.
      const message = `hash backfill failed: ${err instanceof Error ? err.message : String(err)}`;
      await writeRefreshLog(env, source.slug, 'error', 0, Date.now() - start, message);
      throw err;
    }
    const elapsed = backfillClock.now() - start;
    const handOver = elapsed >= BACKFILL_HANDOVER_MS;
    if (backfill.left > 0 || elapsed >= BACKFILL_BUDGET_MS || handOver) {
      const message =
        backfill.left > 0
          ? `hash backfill: ${backfill.done} rows hashed, ${backfill.left} left; delta refresh resumes once complete`
          : `hash backfill: ${backfill.done} rows hashed, 0 left in ${Math.round(elapsed / 1000)} s; delta refresh runs next night`;
      console.log(
        JSON.stringify({ level: 'info', event: 'hash_backfill', source: source.slug, ...backfill }),
      );
      await writeRefreshLog(
        env,
        source.slug,
        'skipped',
        backfill.done,
        Date.now() - start,
        message,
      );
      return previous;
    }
    const index = await loadStoredIndex(env, source.slug, previous.generation).catch(
      (err: unknown) => {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'delta_index_failed',
            source: source.slug,
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return null;
      },
    );
    if (index) return traceOrigin(() => refreshD1Delta(env, source, previous, index, start));
  }
  return traceOrigin(() => refreshD1Full(env, source, previous, start));
}

/** Rows per page when reading the stored (seq, id, hash) index back. */
const INDEX_PAGE = 50_000;

/** Rows per hash-backfill page (the record text comes back, ~1–2 KB each). */
const BACKFILL_PAGE = 2_000;
/**
 * Wall-clock the backfill may take of a wave before it hands the rest to the next night: what
 * remains of the 15-minute Cron Trigger budget is for the delta pass that follows.
 */
export const BACKFILL_BUDGET_MS = 8 * 60_000;
/**
 * A backfill that took this long leaves the delta pass to the next night even when it finished:
 * the journal's full reload took 13 min 42 s of the 15-minute wave on 2026-10-04, so a backfill
 * of some minutes and a delta of some more must never share one wave (2026-10-09).
 */
export const BACKFILL_HANDOVER_MS = 3 * 60_000;
/** Injectable clock for the backfill budget (tests drive it; production is Date.now). */
export const backfillClock = { now: (): number => Date.now() };

const BACKFILL_SELECT_SQL = `SELECT seq, record FROM source_records
   WHERE source_slug = ?1 AND generation = ?2 AND seq > ?3 AND (record_id IS NULL OR record_hash IS NULL)
   ORDER BY seq LIMIT ${BACKFILL_PAGE}`;
/**
 * The page's ids and hashes written by seq. The 2,000 entries are MATERIALIZED first so SQLite
 * loops over them and probes each row through the primary key (`SCAN j` then `SEARCH r … seq=?`).
 * Written as an UPDATE … FROM a json_each subquery (2026-10-07) the planner did the reverse —
 * walked every row of the generation and scanned the 2,000 entries for each one, 324M evaluations
 * a page for uk-trademark-journal's 162k rows: 200 s a page measured in SQLite, longer on D1, so
 * the budget check between pages never ran before the 15-minute Cron Trigger limit killed the
 * wave with no refresh_log row (10-08, 10-09). The plan is asserted in d1store.spec.
 */
export const BACKFILL_UPDATE_SQL = `WITH j(q, i, h) AS MATERIALIZED (
     SELECT json_extract(value, '$.q'), json_extract(value, '$.i'), json_extract(value, '$.h') FROM json_each(?3))
   UPDATE source_records AS r SET record_id = j.i, record_hash = j.h
   FROM j WHERE r.source_slug = ?1 AND r.generation = ?2 AND r.seq = j.q`;
const BACKFILL_LEFT_SQL = `SELECT COUNT(*) AS n FROM source_records
   WHERE source_slug = ?1 AND generation = ?2 AND (record_id IS NULL OR record_hash IS NULL)`;

/**
 * Writes the id and hash of the live rows that lack them, in place and resumably, so a
 * generation loaded before migration 0014 reaches the delta path without "one last full reload".
 * uk-trademark-journal (162k rows, 52 journal issues re-read from KV) never finished that reload:
 * wave 7 was killed at the 15-minute Cron Trigger limit on 2026-10-05, 10-06 and 10-07 before any
 * refresh_log row, each night first sweeping the previous night's partial generation and then
 * dying again. The hash is `hash53(JSON.stringify(record))` exactly as ingestRow computes it, so
 * the next delta pass finds every untouched row unchanged (asserted on real D1 in d1store.spec).
 * Pages are keyed by seq, so a row whose id is null cannot be re-selected forever. Returns how
 * many rows this run hashed and how many still lack a hash when the budget ran out.
 */
async function backfillHashes(
  env: CloudflareBindings,
  source: DataSource,
  previous: SourceMeta,
  start: number,
): Promise<{ done: number; left: number }> {
  const { generation } = previous;
  const idOf = source.idOf;
  if (!idOf) return { done: 0, left: 0 };
  const select = env.DB.prepare(BACKFILL_SELECT_SQL);
  const update = env.DB.prepare(BACKFILL_UPDATE_SQL);
  let done = 0;
  let after = -1;
  let exhausted = false;
  for (;;) {
    const rows = await select
      .bind(source.slug, generation, after)
      .all<{ seq: number; record: string }>();
    const results = rows.results ?? [];
    if (results.length === 0) {
      exhausted = true;
      break;
    }
    const entries = results.map((row) => {
      const record: unknown = JSON.parse(row.record);
      return { q: row.seq, i: idOf(record), h: hash53(JSON.stringify(record)) };
    });
    await update.bind(source.slug, generation, JSON.stringify(entries)).run();
    done += results.length;
    after = results[results.length - 1]?.seq ?? after;
    if (results.length < BACKFILL_PAGE) {
      exhausted = true;
      break;
    }
    if (backfillClock.now() - start >= BACKFILL_BUDGET_MS) break;
  }
  if (done === 0 && exhausted) return { done: 0, left: 0 };
  const left = await env.DB.prepare(BACKFILL_LEFT_SQL)
    .bind(source.slug, generation)
    .first<{ n: number }>();
  return { done, left: left?.n ?? 0 };
}

/**
 * The live generation's rows as parallel typed arrays, sorted by id hash for
 * binary search: ~20 bytes a row, so uk-food-hygiene's ~610k rows fit in a
 * Worker's memory with room for the streamed download. `null` when any row
 * lacks an id or a hash (written before migration 0014) — the caller then does
 * a full reload, which fills them in.
 */
interface StoredIndex {
  n: number;
  seq: Uint32Array;
  idHash: Float64Array;
  hash: Float64Array;
  /** Row positions ordered by idHash. */
  order: Uint32Array;
  maxSeq: number;
}

async function loadStoredIndex(
  env: CloudflareBindings,
  slug: string,
  generation: number,
): Promise<StoredIndex | null> {
  const gap = await env.DB.prepare(
    'SELECT 1 AS ok FROM source_records WHERE source_slug = ?1 AND generation = ?2 AND (record_id IS NULL OR record_hash IS NULL) LIMIT 1',
  )
    .bind(slug, generation)
    .first<{ ok: number }>();
  if (gap) return null;
  const size = await env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(MAX(seq), -1) AS max FROM source_records WHERE source_slug = ?1 AND generation = ?2',
  )
    .bind(slug, generation)
    .first<{ n: number; max: number }>();
  const n = size?.n ?? 0;
  if (n === 0) return null;
  const index: StoredIndex = {
    n,
    seq: new Uint32Array(n),
    idHash: new Float64Array(n),
    hash: new Float64Array(n),
    order: new Uint32Array(n),
    maxSeq: size?.max ?? -1,
  };
  const page = env.DB.prepare(
    `SELECT seq, record_id, record_hash FROM source_records
     WHERE source_slug = ?1 AND generation = ?2 AND seq > ?3 ORDER BY seq LIMIT ${INDEX_PAGE}`,
  );
  let filled = 0;
  let after = -1;
  for (;;) {
    const rows = await page
      .bind(slug, generation, after)
      .all<{ seq: number; record_id: string; record_hash: number }>();
    const results = rows.results ?? [];
    if (results.length === 0) break;
    for (const row of results) {
      if (filled >= n) return null; // rows appeared under us — not a cron-only store any more
      index.seq[filled] = row.seq;
      index.idHash[filled] = hash53(row.record_id);
      index.hash[filled] = row.record_hash;
      index.order[filled] = filled;
      filled += 1;
      after = row.seq;
    }
    if (results.length < INDEX_PAGE) break;
  }
  if (filled !== n) return null;
  index.order.sort((a, b) => index.idHash[a] - index.idHash[b]);
  return index;
}

/** Position of the stored row whose id hashes to `h`, or -1. */
function findStored(index: StoredIndex, h: number): number {
  let lo = 0;
  let hi = index.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const pos = index.order[mid];
    const v = index.idHash[pos];
    if (v === h) return pos;
    if (v < h) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const UPSERT_SQL = `INSERT INTO source_records (source_slug, generation, seq, search, record, record_lc, record_id, record_hash)
   SELECT ?1, ?2, json_extract(value, '$.q'), json_extract(value, '$.s'), json_extract(value, '$.r'), json_extract(value, '$.l'), json_extract(value, '$.i'), json_extract(value, '$.h')
   FROM json_each(?3) WHERE true
   ON CONFLICT (source_slug, generation, seq) DO UPDATE SET
     search = excluded.search, record = excluded.record, record_lc = excluded.record_lc,
     record_id = excluded.record_id, record_hash = excluded.record_hash`;
/** Change-feed rows copied from the live rows named by seq (after an upsert, or before a delete). */
const CHANGES_FROM_ROWS_SQL = `INSERT OR IGNORE INTO source_changes (source_slug, changed_at, change, record_id, record, search, record_lc)
   SELECT source_slug, ?3, ?4, record_id, record, search, record_lc FROM source_records
   WHERE source_slug = ?1 AND generation = ?2 AND seq IN (SELECT value FROM json_each(?5))`;
const DELETE_ROWS_SQL = `DELETE FROM source_records
   WHERE source_slug = ?1 AND generation = ?2 AND seq IN (SELECT value FROM json_each(?3))`;

/**
 * In-place refresh of the live generation (cloudflare-usage-breakdown, 2026-10-04).
 * Streams the source once, looks each record up by id hash in the stored index
 * and writes only what differs: changed rows are upserted by their seq, new ids
 * appended after the highest seq, and ids the source no longer yields deleted
 * once the stream ends; each chunk lands with its change-feed rows in one
 * transactional batch. Registers move by well under 1% a day, so this writes
 * ~1% of the rows the generation swap wrote (D1 bills rows written). The price
 * is that a request during the refresh sees today's version of some rows and
 * yesterday's of the rest — every row is present throughout, nothing is ever
 * partially loaded, and a crash mid-way self-heals: the next refresh compares
 * against whatever hashes are stored. A stream that yields 0 records changes
 * nothing (origin outage vs real-empty is indistinguishable; the error names the
 * first page the origin served, origin.ts).
 */
async function refreshD1Delta(
  env: CloudflareBindings,
  source: DataSource,
  previous: SourceMeta,
  index: StoredIndex,
  start: number,
): Promise<SourceMeta> {
  const { generation } = previous;
  const changedAt = new Date().toISOString();
  try {
    // A crashed full reload may have left orphan rows above the live generation.
    await deleteGenerations(env, source.slug, '>=', generation + 1);
    const seen = new Uint8Array(index.n);
    let nextSeq = index.maxSeq + 1;
    let streamed = 0;
    let added = 0;
    let changed = 0;
    let chunk: (IngestRow & { q: number })[] = [];
    let addedSeqs: number[] = [];
    let changedSeqs: number[] = [];
    let chunkBytes = 0;
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      const batch = [
        env.DB.prepare(UPSERT_SQL).bind(source.slug, generation, JSON.stringify(chunk)),
      ];
      for (const [kind, seqs] of [
        ['added', addedSeqs],
        ['changed', changedSeqs],
      ] as const) {
        if (seqs.length === 0) continue;
        batch.push(
          env.DB.prepare(CHANGES_FROM_ROWS_SQL).bind(
            source.slug,
            generation,
            changedAt,
            kind,
            JSON.stringify(seqs),
          ),
        );
      }
      await env.DB.batch(batch);
      chunk = [];
      addedSeqs = [];
      changedSeqs = [];
      chunkBytes = 0;
    };
    const records: AsyncIterable<unknown> | unknown[] = source.fetchStream
      ? source.fetchStream(env)
      : await source.fetchFresh(env);
    for await (const record of records) {
      streamed += 1;
      const json = JSON.stringify(record);
      const entry = ingestRow(source, record, json);
      const pos = findStored(index, hash53(entry.i ?? ''));
      if (pos >= 0) {
        seen[pos] = 1;
        if (index.hash[pos] === entry.h) continue; // unchanged: no write at all
        changed += 1;
        changedSeqs.push(index.seq[pos]);
        chunk.push({ ...entry, q: index.seq[pos] });
      } else {
        added += 1;
        addedSeqs.push(nextSeq);
        chunk.push({ ...entry, q: nextSeq });
        nextSeq += 1;
      }
      chunkBytes += ingestBytes(entry, json);
      if (chunk.length >= INSERT_CHUNK || chunkBytes >= INSERT_CHUNK_BYTES) await flush();
    }
    if (streamed === 0) throw zeroRecordsError();
    await flush();

    // Rows the source no longer yields: feed row first, then the delete, one batch per chunk.
    let removed = 0;
    let removedSeqs: number[] = [];
    const flushRemoved = async (): Promise<void> => {
      if (removedSeqs.length === 0) return;
      const seqs = JSON.stringify(removedSeqs);
      await env.DB.batch([
        env.DB.prepare(CHANGES_FROM_ROWS_SQL).bind(
          source.slug,
          generation,
          changedAt,
          'removed',
          seqs,
        ),
        env.DB.prepare(DELETE_ROWS_SQL).bind(source.slug, generation, seqs),
      ]);
      removedSeqs = [];
    };
    for (let pos = 0; pos < index.n; pos += 1) {
      if (seen[pos]) continue;
      removed += 1;
      removedSeqs.push(index.seq[pos]);
      if (removedSeqs.length >= INSERT_CHUNK) await flushRemoved();
    }
    await flushRemoved();

    const meta: SourceMeta = {
      generation,
      last_refreshed_at: changedAt,
      total: index.n + added - removed,
    };
    await env.DB.batch([
      env.DB.prepare(
        'UPDATE source_meta SET last_refreshed_at = ?2, total = ?3 WHERE source_slug = ?1',
      ).bind(source.slug, meta.last_refreshed_at, meta.total),
      env.DB.prepare(
        "DELETE FROM source_changes WHERE source_slug = ?1 AND changed_at < datetime('now', ?2)",
      ).bind(source.slug, `-${CHANGES_RETENTION_DAYS} days`),
    ]);
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'refresh_delta',
        source: source.slug,
        streamed,
        added,
        changed,
        removed,
        unchanged: streamed - added - changed,
      }),
    );

    await precomputeStats(env, source, generation, meta);
    await writeRefreshLog(
      env,
      source.slug,
      'ok',
      meta.total,
      Date.now() - start,
      `delta +${added} ~${changed} -${removed}`,
    );
    return meta;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeRefreshLog(env, source.slug, 'error', 0, Date.now() - start, message);
    throw err;
  }
}

/**
 * Precompute the /stats aggregation once here (cron), so the public,
 * unauthenticated /stats page never runs a full-table GROUP BY per request.
 * Best-effort: a stats-cache failure must not fail the data refresh.
 */
async function precomputeStats(
  env: CloudflareBindings,
  source: DataSource,
  generation: number,
  meta: SourceMeta,
): Promise<void> {
  try {
    const stats = await aggregateD1Stats(env, source, generation, meta.total);
    await putSourceStats(env, source, stats, meta.last_refreshed_at);
  } catch (statsErr) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'stats_precompute_failed',
        source: source.slug,
        reason: statsErr instanceof Error ? statsErr.message : String(statsErr),
      }),
    );
  }
}

/** Full reload into generation+1, then the atomic meta flip (see refreshD1Source). */
async function refreshD1Full(
  env: CloudflareBindings,
  source: DataSource,
  previous: SourceMeta | null,
  start: number,
): Promise<SourceMeta> {
  try {
    const generation = (previous?.generation ?? 0) + 1;

    // Idempotency sweep: meta only advances on success, so a prior crashed
    // attempt left orphan rows at THIS same generation. Clear them first —
    // otherwise the first chunk's seq=0 collides on the PK and every future
    // refresh throws, wedging the dataset on stale data permanently.
    await deleteGenerations(env, source.slug, '>=', generation);

    // Chunked set-based insert: one statement per chunk via json_each keeps
    // bind counts tiny (D1 caps bound parameters per statement). fetchStream
    // (preferred when present) holds only one chunk in memory, so datasets far
    // beyond Worker memory can load; fetchFresh materializes like the KV path.
    const insert = env.DB.prepare(
      `INSERT INTO source_records (source_slug, generation, seq, search, record, record_lc, record_id, record_hash)
       SELECT ?1, ?2, key + ?3, json_extract(value, '$.s'), json_extract(value, '$.r'), json_extract(value, '$.l'), json_extract(value, '$.i'), json_extract(value, '$.h')
       FROM json_each(?4)`,
    );
    let total = 0;
    let chunk: IngestRow[] = [];
    let chunkBytes = 0;
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      await insert.bind(source.slug, generation, total - chunk.length, JSON.stringify(chunk)).run();
      chunk = [];
      chunkBytes = 0;
    };
    const records: AsyncIterable<unknown> | unknown[] = source.fetchStream
      ? source.fetchStream(env)
      : await source.fetchFresh(env);
    for await (const record of records) {
      const json = JSON.stringify(record);
      const entry = ingestRow(source, record, json);
      chunk.push(entry);
      chunkBytes += ingestBytes(entry, json);
      total += 1;
      if (chunk.length >= INSERT_CHUNK || chunkBytes >= INSERT_CHUNK_BYTES) await flush();
    }
    await flush();
    if (total === 0) {
      // Never flip meta to an empty generation (origin outage vs real-empty is
      // indistinguishable); readers keep the prior generation. The partial rows
      // at this generation are cleared by the next attempt's idempotency sweep.
      throw zeroRecordsError();
    }

    const meta: SourceMeta = {
      generation,
      last_refreshed_at: new Date().toISOString(),
      total,
    };
    await env.DB.prepare(
      `INSERT INTO source_meta (source_slug, generation, last_refreshed_at, total)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (source_slug) DO UPDATE
       SET generation = ?2, last_refreshed_at = ?3, total = ?4`,
    )
      .bind(source.slug, meta.generation, meta.last_refreshed_at, meta.total)
      .run();
    // Readers are on the new generation now. Before the old generation goes,
    // diff it against the new one for the change feed (best-effort).
    if (source.idOf && previous) {
      try {
        await recordChanges(
          env,
          source.slug,
          previous.generation,
          generation,
          meta.last_refreshed_at,
        );
      } catch (diffErr) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'change_diff_failed',
            source: source.slug,
            reason: diffErr instanceof Error ? diffErr.message : String(diffErr),
          }),
        );
      }
    }
    // Drop every older generation.
    await deleteGenerations(env, source.slug, '<', generation);

    await precomputeStats(env, source, generation, meta);
    await writeRefreshLog(env, source.slug, 'ok', total, Date.now() - start, null);
    return meta;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeRefreshLog(env, source.slug, 'error', 0, Date.now() - start, message);
    throw err;
  }
}

interface SqlPredicate {
  sql: string;
  binds: (string | number)[];
}

// JSON-path helper. Field names are code-defined (zod-schema keys / StatsSpec
// fields), never user input — but this is the ONE place a string is
// interpolated into SQL, so assert the identifier shape defensively. Turns a
// future footgun (a dev putting a quote in a queryParams key or stats field)
// into a loud error at first use instead of a silent injection.
const IDENT = /^[A-Za-z0-9_]+$/;
function path(field: string): string {
  if (!IDENT.test(field)) {
    throw new Error(`unsafe D1 field identifier: ${JSON.stringify(field)}`);
  }
  return `'$.${field}'`;
}

/**
 * One predicate per query param, mirroring applyQuery's semantics. Unknown
 * shapes (e.g. a range suffix on a non-matching type) fall back to the
 * equality/substring rule, exactly like the JS engine.
 */
function predicateFor(key: string, wanted: unknown): SqlPredicate | null {
  if (key.endsWith(PRESENT_SUFFIX) && typeof wanted === 'boolean') {
    // Mirrors isPresent(): missing key (json_type NULL) / JSON null / '' / [] are absent,
    // anything else present. A searched CASE — a simple CASE on a NULL operand would fall to ELSE.
    const p = path(key.slice(0, -PRESENT_SUFFIX.length));
    const t = `json_type(record, ${p})`;
    return {
      sql: `(CASE WHEN ${t} IS NULL OR ${t} = 'null' THEN 0 WHEN ${t} = 'text' THEN trim(json_extract(record, ${p})) != '' WHEN ${t} = 'array' THEN json_array_length(record, ${p}) > 0 ELSE 1 END) = ?`,
      binds: [wanted ? 1 : 0],
    };
  }
  if (key.endsWith('_after') && typeof wanted === 'string') {
    const field = key.slice(0, -'_after'.length);
    return { sql: `json_extract(record, ${path(field)}) >= ?`, binds: [wanted.slice(0, 10)] };
  }
  if (key.endsWith('_before') && typeof wanted === 'string') {
    const field = key.slice(0, -'_before'.length);
    return { sql: `json_extract(record, ${path(field)}) <= ?`, binds: [wanted.slice(0, 10)] };
  }
  if (key.endsWith('_min') && typeof wanted === 'number') {
    const field = key.slice(0, -'_min'.length);
    return {
      sql: `typeof(json_extract(record, ${path(field)})) IN ('integer','real') AND json_extract(record, ${path(field)}) >= ?`,
      binds: [wanted],
    };
  }
  if (key.endsWith('_max') && typeof wanted === 'number') {
    const field = key.slice(0, -'_max'.length);
    return {
      sql: `typeof(json_extract(record, ${path(field)})) IN ('integer','real') AND json_extract(record, ${path(field)}) <= ?`,
      binds: [wanted],
    };
  }
  if (typeof wanted === 'boolean') {
    // Strict equality like matchesValue. json_extract of a JSON true/false
    // yields 1/0; bind the same so a boolean param filters correctly.
    return { sql: `json_extract(record, ${path(key)}) = ?`, binds: [wanted ? 1 : 0] };
  }
  if (typeof wanted === 'string') {
    // Case-insensitive substring, like matchesValue. Match against record_lc
    // (JS-lowercased at ingest) so folding matches the KV path's toLowerCase
    // for non-ASCII too; fall back to SQLite lower(record) for rows written
    // before record_lc existed. The typeof guard mirrors matchesValue: a string
    // param only matches TEXT fields (a number field yields no substring match).
    const p = path(key);
    return {
      sql: `typeof(json_extract(record, ${p})) = 'text' AND instr(COALESCE(json_extract(record_lc, ${p}), lower(json_extract(record, ${p}))), ?) > 0`,
      binds: [wanted.toLowerCase()],
    };
  }
  if (typeof wanted === 'number') {
    return { sql: `json_extract(record, ${path(key)}) = ?`, binds: [wanted] };
  }
  return null;
}

/**
 * The filter part of a WHERE (anonymous `?` binds, one clause per param) —
 * shared by source_records queries, the change feed and the facet stats, so
 * every surface filters a record identically.
 */
function filterPredicate(parsed: Record<string, unknown>): {
  clauses: string[];
  binds: (string | number)[];
} {
  const clauses: string[] = [];
  const binds: (string | number)[] = [];
  if (typeof parsed.q === 'string') {
    // source_changes rows written before migration 0012 have no search column value.
    clauses.push('instr(COALESCE(search, lower(record)), ?) > 0');
    binds.push(parsed.q.toLowerCase());
  }
  for (const [key, wanted] of Object.entries(parsed)) {
    if (RESERVED.has(key) || wanted === undefined) continue;
    const predicate = predicateFor(key, wanted);
    if (predicate) {
      clauses.push(`(${predicate.sql})`);
      binds.push(...predicate.binds);
    }
  }
  return { clauses, binds };
}

function buildWhere(
  slug: string,
  generation: number,
  parsed: Record<string, unknown>,
): SqlPredicate {
  const filters = filterPredicate(parsed);
  return {
    sql: ['source_slug = ?', 'generation = ?', ...filters.clauses].join(' AND '),
    binds: [slug, generation, ...filters.binds],
  };
}

export interface D1QueryResult {
  page: QueryPage<unknown>;
  last_refreshed_at: string;
}

export async function queryD1Source(
  env: CloudflareBindings,
  source: DataSource,
  parsed: Record<string, unknown>,
): Promise<D1QueryResult> {
  // Read committed state only — NEVER trigger a refresh from the request path
  // (a D1 reload is a multi-minute upstream pull; letting a request drive it
  // was an unauthenticated-DoS vector). Cron is the sole loader.
  const meta = await readMeta(env, source.slug);
  if (!meta) throw new SourceNotLoadedError(source.slug);
  const where = buildWhere(source.slug, meta.generation, parsed);
  const page = parsed.page as number;
  const perPage = parsed.per_page as number;

  const [countRow, rows] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM source_records WHERE ${where.sql}`)
      .bind(...where.binds)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT record FROM source_records WHERE ${where.sql} ORDER BY seq LIMIT ?${where.binds.length + 1} OFFSET ?${where.binds.length + 2}`,
    )
      .bind(...where.binds, perPage, (page - 1) * perPage)
      .all<{ record: string }>(),
  ]);

  return {
    page: {
      records: (rows.results ?? []).map((row) => JSON.parse(row.record) as unknown),
      page,
      perPage,
      total: countRow?.n ?? 0,
    },
    last_refreshed_at: meta.last_refreshed_at,
  };
}

/**
 * SQL aggregation mirroring lib/stats computeStats for D1 sources. Called ONCE
 * per refresh (cron) against the just-committed generation; the result is
 * cached so /stats never scans the table per request.
 */
/**
 * Daily added / removed / changed counts from the change feed for the /stats
 * page (newest first, 30 days). One indexed GROUP BY at refresh time — the
 * change feed is the product every competitor lacks, so its activity is shown
 * where buyers look before they sign up.
 */
async function aggregateChangeDays(env: CloudflareBindings, slug: string): Promise<ChangeDay[]> {
  const rows = await env.DB.prepare(
    `SELECT substr(changed_at, 1, 10) AS day, change, COUNT(*) AS n FROM source_changes
     WHERE source_slug = ?1 AND changed_at >= datetime('now', '-30 days')
     GROUP BY day, change ORDER BY day DESC`,
  )
    .bind(slug)
    .all<{ day: string; change: string; n: number }>();
  const byDay = new Map<string, ChangeDay>();
  for (const row of rows.results ?? []) {
    const day = byDay.get(row.day) ?? { date: row.day, added: 0, removed: 0, changed: 0 };
    if (row.change === 'added' || row.change === 'removed' || row.change === 'changed') {
      day[row.change] = row.n;
    }
    byDay.set(row.day, day);
  }
  return [...byDay.values()];
}

async function aggregateMonthly(
  env: CloudflareBindings,
  where: SqlPredicate,
  date: { field: string; title: string },
): Promise<MonthlyTrend | null> {
  const monthExpr = `substr(json_extract(record, ${path(date.field)}), 1, 7)`;
  const monthly = await env.DB.prepare(
    `SELECT ${monthExpr} AS month, COUNT(*) AS n FROM source_records
     WHERE ${where.sql}
       AND json_extract(record, ${path(date.field)}) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]*'
     GROUP BY month ORDER BY month DESC LIMIT 12`,
  )
    .bind(...where.binds)
    .all<{ month: string; n: number }>();
  const buckets = (monthly.results ?? [])
    .reverse()
    .map((row) => ({ month: row.month, count: row.n }));
  return buckets.length > 0 ? { title: date.title, buckets } : null;
}

async function aggregateGroups(
  env: CloudflareBindings,
  where: SqlPredicate,
  specs: StatsGroupSpec[],
): Promise<StatsGroup[]> {
  const groups: StatsGroup[] = [];
  for (const group of specs) {
    const valueExpr = `json_extract(record, ${path(group.field)})`;
    const order = group.sort === 'value' ? 'value ASC' : 'n DESC, value ASC';
    const rows = await env.DB.prepare(
      `SELECT ${valueExpr} AS value, COUNT(*) AS n FROM source_records
       WHERE ${where.sql}
         AND ${valueExpr} IS NOT NULL AND ${valueExpr} != ''
       GROUP BY value ORDER BY ${order} LIMIT ?`,
    )
      .bind(...where.binds, group.limit ?? 10)
      .all<{ value: string | number; n: number }>();
    const groupRows = sortGroupRows(
      (rows.results ?? []).map((row) => ({ value: String(row.value), count: row.n })),
      group.sort,
    );
    if (groupRows.length > 0) groups.push({ title: group.title, rows: groupRows });
  }
  return groups;
}

/**
 * Wall-clock budget for the facet sub-pages of one source: each listed value
 * costs 2 + groupBy.length scans of the generation, so a 45-value facet is a
 * few hundred statements. Past the budget the remaining pages are left out
 * (they 503 "being prepared" until tomorrow) rather than risk the wave's
 * 15-minute Cron Trigger limit.
 */
const FACETS_BUDGET_MS = 240_000;

async function aggregateFacets(
  env: CloudflareBindings,
  source: DataSource,
  generation: number,
  facets: StatsFacet[],
): Promise<FacetStats[]> {
  const started = Date.now();
  const out: FacetStats[] = [];
  for (const facet of facets) {
    const stats: FacetStats = {
      segment: facet.segment,
      field: facet.field,
      title: facet.title,
      pages: [],
    };
    for (const { value, label } of facet.values) {
      if (Date.now() - started > FACETS_BUDGET_MS) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'stats_facets_budget',
            source: source.slug,
            segment: facet.segment,
            computed: stats.pages.length,
            of: facet.values.length,
          }),
        );
        break;
      }
      const where = buildWhere(source.slug, generation, { [facet.field]: value });
      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM source_records WHERE ${where.sql}`,
      )
        .bind(...where.binds)
        .first<{ n: number }>();
      stats.pages.push({
        value,
        label,
        total: count?.n ?? 0,
        monthly: facet.date ? await aggregateMonthly(env, where, facet.date) : null,
        groups: await aggregateGroups(env, where, facet.groupBy),
      });
    }
    out.push(stats);
  }
  return out;
}

async function aggregateD1Stats(
  env: CloudflareBindings,
  source: DataSource,
  generation: number,
  total: number,
): Promise<SourceStats> {
  const spec: StatsSpec | undefined = source.stats;
  const stats: SourceStats = { total, monthly: null, groups: [] };
  if (source.idOf) stats.changes = await aggregateChangeDays(env, source.slug);
  if (!spec) return stats;
  const where = buildWhere(source.slug, generation, {});
  stats.monthly = await aggregateMonthly(env, where, spec.date);
  stats.groups = await aggregateGroups(env, where, spec.groupBy);
  if (spec.facets) stats.facets = await aggregateFacets(env, source, generation, spec.facets);
  return stats;
}
