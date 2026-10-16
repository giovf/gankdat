import { computeStats } from '../lib/stats';
import type { SourceStats } from '../lib/stats';
import { readCached, readSnapshot, readSourceStats, refreshSource } from './cache';
import { queryD1Source, refreshD1Source } from './d1store';
import { isLookup, lookupRecord } from './lookup';
import { applyQuery } from './query';
import type { QueryPage } from './query';
import { listSources } from './registry';
import type { DataSource } from './types';

// Storage-aware dispatch: every consumer of source data (REST route, x402
// lane, MCP tools, stats pages, cron) goes through here, so a source's
// storage choice ('kv' snapshot vs 'd1' rows) never leaks past the registry.

export interface SourceQueryResult {
  page: QueryPage<unknown>;
  last_refreshed_at: string | null;
}

export async function querySource(
  env: CloudflareBindings,
  source: DataSource,
  parsed: Record<string, unknown>,
): Promise<SourceQueryResult> {
  if (isLookup(source)) {
    return lookupRecord(env, source, parsed);
  }
  if (source.storage === 'd1') {
    return queryD1Source(env, source, parsed);
  }
  const payload = await readCached(env, source);
  return {
    page: applyQuery(payload.records, parsed),
    last_refreshed_at: payload.last_refreshed_at,
  };
}

export interface SourceStatsResult {
  stats: SourceStats;
  last_refreshed_at: string | null;
}

/**
 * Stats for the public /stats page. Prefers the blob precomputed at refresh.
 * If that's absent (e.g. just after a deploy, before the next cron), a KV
 * source falls back to computing from its existing cached snapshot — bounded
 * (≤ snapshot size), and crucially WITHOUT triggering a refresh. A D1 source
 * has no cheap fallback (computing means scanning ~100k+ rows), so it returns
 * null → the page shows "warming" until cron precomputes. Never refreshes,
 * never scans the D1 table per request.
 */
export async function sourceStats(
  env: CloudflareBindings,
  source: DataSource,
): Promise<SourceStatsResult | null> {
  const cached = await readSourceStats(env, source.slug);
  if (cached) return { stats: cached.stats, last_refreshed_at: cached.last_refreshed_at };

  if (source.storage !== 'd1' && !isLookup(source)) {
    const snapshot = await readSnapshot(env, source.slug);
    if (snapshot) {
      return {
        stats: computeStats(snapshot.records, source.stats),
        last_refreshed_at: snapshot.last_refreshed_at,
      };
    }
  }
  return null;
}

/**
 * Cron entrypoint: refresh EVERY source on each scheduled tick. Per-source cron
 * is advisory — the platform runs one daily cron, and refreshing all sources
 * means adding a source never silently skips its refresh (no wrangler.jsonc/code
 * cron drift). Never throws.
 */
/**
 * Which wave a trigger runs, from the cron's minute field: 0 → wave 1, 15 → wave 2,
 * 30 → wave 3, 45 → wave 4, 50 → wave 5, 55 → wave 6, 5 → wave 7 (06:05); anything else (a
 * manual/temporary trigger) →
 * every wave in order. Keeping each wave under the 15-minute Cron Trigger limit is what
 * matters — a four-source D1 wave was killed mid-load on 2026-09-20 when D1 ran slow.
 */
export type RefreshWave = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const WAVE_BY_MINUTE: Record<string, RefreshWave> = {
  '0': 1,
  '15': 2,
  '30': 3,
  '45': 4,
  '50': 5,
  '55': 6,
  '5': 7,
};

export function waveForCron(cron: string | undefined): RefreshWave | undefined {
  const minute = (cron ?? '').trim().split(/\s+/)[0] ?? '';
  return WAVE_BY_MINUTE[minute];
}

export function waveOf(source: DataSource): RefreshWave {
  return source.refresh.wave ?? (source.storage === 'd1' ? 2 : 1);
}

/**
 * D1 failures that are the platform's, not the data's: "D1_ERROR: internal
 * error; reference = …" (uk-trademark-journal 2026-09-28) and "Network
 * connection lost" (uk-charities the same morning) each cost a dataset its
 * day. Both refresh paths are idempotent (a crashed D1 generation is swept on
 * the next attempt; a KV snapshot is written last), so one retry is safe.
 */
export const TRANSIENT_D1_ERROR =
  /D1_ERROR: (internal error|Network connection lost)|D1 (is|was) (overloaded|reset)/i;
/** Only retry while the wave has ample room under the 15-minute Cron Trigger limit. */
const RETRY_DEADLINE_MS = 6 * 60_000;
const RETRY_DELAY_MS = 5_000;

export function isTransientD1Error(err: unknown): boolean {
  return TRANSIENT_D1_ERROR.test(err instanceof Error ? err.message : String(err));
}

/** One source's refresh, retried once on a transient D1 error while the wave is young; true when it succeeded. */
export async function refreshOne(
  env: CloudflareBindings,
  source: DataSource,
  waveStartedAt = Date.now(),
  delayMs = RETRY_DELAY_MS,
): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (source.storage === 'd1') {
        await refreshD1Source(env, source);
      } else {
        await refreshSource(env, source);
      }
      return true;
    } catch (err) {
      const retry =
        attempt === 1 && isTransientD1Error(err) && Date.now() - waveStartedAt < RETRY_DEADLINE_MS;
      // Already recorded in refresh_log; keep the loop alive for other sources.
      console.error(
        JSON.stringify({
          level: retry ? 'warn' : 'error',
          event: retry ? 'refresh_retry' : 'refresh_failed',
          source: source.slug,
          attempt,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      if (!retry) return false;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** A source whose refresh a GitHub runner owns (`RefreshPolicy.runner`): the cron waves skip it. */
export function isRunnerFed(source: DataSource): boolean {
  return source.refresh.runner === true;
}

/** The sources one cron wave refreshes (every wave when the cron is unknown); lookup sources have nothing to refresh. */
export function cronSources(wave: RefreshWave | undefined): DataSource[] {
  return listSources().filter(
    (s) => !isRunnerFed(s) && !isLookup(s) && (wave === undefined || waveOf(s) === wave),
  );
}

/**
 * One cron wave: refresh its sources in order. The IndexNow submission of the changed
 * stats pages is the GitHub runner's job after the waves (scripts/runner-refresh.mjs) —
 * api.indexnow.org answers 429 to Workers egress, so the Worker no longer pings.
 */
export async function refreshAllSources(env: CloudflareBindings, cron?: string): Promise<void> {
  const wave = waveForCron(cron);
  const sources = cronSources(wave);
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'refresh_wave',
      cron: cron ?? null,
      wave: wave ?? 'all',
      sources: sources.map((s) => s.slug),
    }),
  );
  const startedAt = Date.now();
  for (const source of sources) {
    await refreshOne(env, source, startedAt);
  }
}
