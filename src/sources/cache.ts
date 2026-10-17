import { computeStats } from '../lib/stats';
import type { SourceStats } from '../lib/stats';
import type { DataSource } from './types';
import { traceOrigin, zeroRecordsError } from './origin';

export interface CachedPayload {
  records: unknown[];
  last_refreshed_at: string;
}

export interface CachedStats {
  stats: SourceStats;
  last_refreshed_at: string;
}

export const dataKey = (slug: string): string => `data:${slug}`;
export const statsKey = (slug: string): string => `srcstats:${slug}`;
const refreshLockKey = (slug: string): string => `refreshlock:${slug}`;

// Keep the last-good payload well past its freshness window so it can be served
// stale while the origin is down (freshness is judged in code, not by KV TTL).
const STALE_RETENTION_FACTOR = 7;

/** KV expiry of a snapshot and its stats blob: the TTL plus a stale-retention margin. */
export function snapshotTtlSeconds(source: DataSource): number {
  return Math.max(60, source.refresh.cacheTtlSeconds * STALE_RETENTION_FACTOR);
}

/**
 * The two KV writes one refresh makes, as key/value/ttl — shared by the Worker's
 * refresh and the runner-side refresh (`scripts/runner-refresh.mjs`) so a snapshot
 * written from a GitHub runner is byte-for-byte what the Worker would have written.
 */
export function snapshotWrites(
  source: DataSource,
  records: unknown[],
  lastRefreshedAt: string,
): { key: string; value: string; ttl: number }[] {
  const ttl = snapshotTtlSeconds(source);
  const payload: CachedPayload = { records, last_refreshed_at: lastRefreshedAt };
  const stats: CachedStats = {
    stats: computeStats(records, source.stats),
    last_refreshed_at: lastRefreshedAt,
  };
  return [
    { key: dataKey(source.slug), value: JSON.stringify(payload), ttl },
    { key: statsKey(source.slug), value: JSON.stringify(stats), ttl },
  ];
}

// Best-effort single-flight window. Concurrent request-path refreshers see the
// lock and serve stale (or 503) instead of each hammering the upstream — which
// for keyed/fair-use origins (Companies House 600/5min, Gazette 5/10s) means a
// refresh storm can no longer get our shared key banned. Best-effort only: KV
// has no atomic CAS, so this coalesces but doesn't perfectly serialize; the TTL
// bounds a crashed holder. Cron refreshes bypass it (they must always run).
const REFRESH_LOCK_TTL_SECONDS = 120;

/** Precomputed /stats payload; written at refresh, read by the public page. */
export async function readSourceStats(
  env: CloudflareBindings,
  slug: string,
): Promise<CachedStats | null> {
  return env.CACHE.get<CachedStats>(statsKey(slug), 'json');
}

export async function putSourceStats(
  env: CloudflareBindings,
  source: DataSource,
  stats: SourceStats,
  lastRefreshedAt: string,
): Promise<void> {
  const payload: CachedStats = { stats, last_refreshed_at: lastRefreshedAt };
  await env.CACHE.put(statsKey(source.slug), JSON.stringify(payload), {
    expirationTtl: snapshotTtlSeconds(source),
  });
}

function isFresh(payload: CachedPayload, source: DataSource): boolean {
  return Date.now() - Date.parse(payload.last_refreshed_at) < source.refresh.cacheTtlSeconds * 1000;
}

/**
 * Non-refreshing snapshot read (KV sources): returns the last-good payload if
 * present, else null. Used by /stats to compute from the existing snapshot
 * without ever triggering an origin refresh.
 */
export async function readSnapshot(
  env: CloudflareBindings,
  slug: string,
): Promise<CachedPayload | null> {
  return env.CACHE.get<CachedPayload>(dataKey(slug), 'json');
}

/**
 * Serve fresh cache; on staleness/miss, refresh — but coalesce concurrent
 * request-path refreshers via a best-effort KV lock so a burst of misses can't
 * storm a keyed/fair-use origin. If refresh fails or the lock is held by
 * another refresher, serve the last-known-good payload; only a cold cache with
 * nothing to serve surfaces as a 503.
 */
export async function readCached(
  env: CloudflareBindings,
  source: DataSource,
): Promise<CachedPayload> {
  const hit = await env.CACHE.get<CachedPayload>(dataKey(source.slug), 'json');
  if (hit && isFresh(hit, source)) return hit;
  // A runner-fed source is never refreshed from here while a snapshot exists: the
  // Worker cannot read its origin (that is why it is runner-fed), and each doomed
  // attempt would cost the request its retry pauses before serving the same bytes.
  if (hit && source.refresh.runner) return hit;

  const lockKey = refreshLockKey(source.slug);
  let acquired = false;
  let busy = false;
  try {
    if (await env.CACHE.get(lockKey)) {
      busy = true; // another isolate is already refreshing
    } else {
      await env.CACHE.put(lockKey, '1', { expirationTtl: REFRESH_LOCK_TTL_SECONDS });
      acquired = true;
    }
  } catch {
    // KV error → fail open and attempt the refresh (availability over coalescing).
    acquired = true;
  }

  if (busy) {
    // Don't pile onto the in-flight refresh: serve stale if we have it, else
    // 503 (the holder populates the cache within seconds).
    if (hit) return hit;
    throw new Error(`refresh in progress for '${source.slug}', no cached data yet`);
  }

  try {
    return await refreshSource(env, source);
  } catch (err) {
    if (hit) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'served_stale',
          source: source.slug,
          last_refreshed_at: hit.last_refreshed_at,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      return hit;
    }
    throw err;
  } finally {
    if (acquired) {
      try {
        await env.CACHE.delete(lockKey);
      } catch {
        // lock will expire on its TTL
      }
    }
  }
}

/** Pull fresh records, cache them, and record the attempt in refresh_log. */
export async function refreshSource(
  env: CloudflareBindings,
  source: DataSource,
): Promise<CachedPayload> {
  const start = Date.now();
  try {
    // A live source that suddenly returns nothing is almost always an origin
    // outage or schema change, not a real empty dataset. Treat it as an error so
    // the good cache is retained (readCached serves it stale) and refresh_log
    // shows the failure, instead of silently caching an empty result as healthy.
    // The error names the first page the origin served (origin.ts) so the row
    // tells an emptied dataset from a 5xx page without a relay round-trip.
    const records = await traceOrigin(async () => {
      const fetched = await source.fetchFresh(env);
      if (fetched.length === 0) throw zeroRecordsError();
      return fetched;
    });
    const payload: CachedPayload = { records, last_refreshed_at: new Date().toISOString() };
    await env.CACHE.put(dataKey(source.slug), JSON.stringify(payload), {
      expirationTtl: snapshotTtlSeconds(source),
    });
    // Precompute /stats over the ≤MAX_RECORDS snapshot so the public page reads
    // a cached blob rather than recomputing per request. Best-effort.
    try {
      await putSourceStats(
        env,
        source,
        computeStats(records, source.stats),
        payload.last_refreshed_at,
      );
    } catch {
      // stale/absent stats just yields a "warming" page — never fail the refresh
    }
    await writeRefreshLog(env, source.slug, 'ok', records.length, Date.now() - start, null);
    return payload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeRefreshLog(env, source.slug, 'error', 0, Date.now() - start, message);
    await retainSnapshot(env, source);
    throw err;
  }
}

/**
 * A failed refresh keeps the last snapshot alive (2026-10-17, gankdat
 * `uk-planning-paused-snapshot-retention`). The data and stats keys expire at
 * snapshotTtlSeconds (7 × the cache TTL) and a refresh that throws writes nothing,
 * so a paused origin — uk-planning, empty since 10-10 by the origin's doing — lost its
 * last snapshot seven days later and every call 503'd, the probe read red and the
 * indexed /stats page became a JSON 503. Re-put whatever is there, byte for byte, with
 * a fresh TTL: no origin read, best-effort, never throws. True when a snapshot was kept.
 */
export async function retainSnapshot(
  env: CloudflareBindings,
  source: DataSource,
): Promise<boolean> {
  try {
    const ttl = snapshotTtlSeconds(source);
    const data = await env.CACHE.get(dataKey(source.slug));
    if (data === null) return false;
    await env.CACHE.put(dataKey(source.slug), data, { expirationTtl: ttl });
    const stats = await env.CACHE.get(statsKey(source.slug));
    if (stats !== null) await env.CACHE.put(statsKey(source.slug), stats, { expirationTtl: ttl });
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'snapshot_retained',
        source: source.slug,
        stats: stats !== null,
        ttl_seconds: ttl,
      }),
    );
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'snapshot_retain_failed',
        source: source.slug,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

export async function writeRefreshLog(
  env: CloudflareBindings,
  slug: string,
  status: 'ok' | 'error' | 'skipped',
  records: number,
  durationMs: number,
  message: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO refresh_log (source_slug, status, records, duration_ms, message) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
      .bind(slug, status, records, durationMs, message)
      .run();
  } catch (err) {
    // Guarded: a missing local migration must not take the API down.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'refresh_log_write_failed',
        source: slug,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
