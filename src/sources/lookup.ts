import { applyQuery } from './query';
import type { QueryPage } from './query';
import type { DataSource } from './types';

// Generic engine for on-demand datasets (DataSource.lookup, 2026-10-07): the
// request names one record by a key param, the engine serves it from a per-key
// KV cache or reads it from the origin through the source's fetchOne. Nothing
// here knows which origin or which fields — that stays in the source file
// (isolation rule). A confirmed miss is cached too (shorter), so a mistyped
// key cannot be used to burn the shared origin quota.

export const MISS_TTL_SECONDS = 3_600;

export interface CachedLookup {
  record: unknown | null;
  fetched_at: string;
}

export const lookupKey = (slug: string, key: string, value: string): string =>
  `lookup:${slug}:${key}=${value}`;

export function isLookup(source: DataSource): boolean {
  return source.lookup !== undefined;
}

/**
 * The first lookup key the request presents, normalised (trimmed, lower-cased)
 * for the cache; null when the request names none.
 */
export function presentedKey(
  source: DataSource,
  parsed: Record<string, unknown>,
): { key: string; value: string } | null {
  if (!source.lookup) return null;
  for (const key of source.lookup.keys) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return { key, value: value.trim().toLowerCase() };
    }
  }
  return null;
}

/** The 400 text when a lookup source is queried without any of its keys; null otherwise. */
export function missingLookupKey(
  source: DataSource,
  parsed: Record<string, unknown>,
): string | null {
  if (!source.lookup || presentedKey(source, parsed)) return null;
  const keys = source.lookup.keys.join(' or ');
  const example = Object.entries(source.lookup.example)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `'${source.slug}' is a lookup: give ${keys} (e.g. ?${example})`;
}

export interface LookupResult {
  page: QueryPage<unknown>;
  /** When the served record was read from the origin (the cache's age). */
  last_refreshed_at: string;
}

/**
 * Serve one record by key: KV first (per key, TTL from the source), else the
 * origin via fetchOne, caching hits for the source's TTL and misses for an
 * hour. The source's other filters and q still apply to the one record, so a
 * lookup composes with the generic query language like any dataset.
 */
export async function lookupRecord(
  env: CloudflareBindings,
  source: DataSource,
  parsed: Record<string, unknown>,
): Promise<LookupResult> {
  const spec = source.lookup;
  const presented = presentedKey(source, parsed);
  if (!spec || !presented) {
    throw new Error(`lookup '${source.slug}' called without a key`);
  }
  const cacheKey = lookupKey(source.slug, presented.key, presented.value);
  let hit: CachedLookup | null = null;
  try {
    hit = await env.CACHE.get<CachedLookup>(cacheKey, 'json');
  } catch {
    // KV read failure: fall through to the origin (availability over caching).
  }
  if (!hit) {
    const record = await spec.fetchOne(env, parsed);
    hit = { record, fetched_at: new Date().toISOString() };
    try {
      await env.CACHE.put(cacheKey, JSON.stringify(hit), {
        expirationTtl: Math.max(60, record === null ? MISS_TTL_SECONDS : spec.cacheTtlSeconds),
      });
    } catch {
      // A failed cache write costs the next request an origin read, nothing more.
    }
  }
  const records = hit.record === null ? [] : [hit.record];
  return { page: applyQuery(records, parsed), last_refreshed_at: hit.fetched_at };
}
