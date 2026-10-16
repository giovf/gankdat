import type { MiddlewareHandler } from 'hono';
import { hashKey } from './keys';
import { ACCESS_TOKEN_PREFIX, resolveAccessToken } from './oauth';
import { failure } from '../lib/envelope';
import type { AppEnv, KeyContext } from '../types';

interface KeyRecord {
  id: string;
  plan: string;
  revoked_at: string | null;
  account_id: string;
  account_email: string;
}

// The quota cap derives from the plan (billing/plans.ts planAllowance), so the
// hot path only needs the plan — no ledger join. Kept short (KV minimum, 60s)
// so revocation and plan changes propagate quickly: the KV-delete on revoke/
// top-up races with this put and KV is eventually consistent, so staleness is
// bounded to ~this TTL rather than being truly instant. A Durable Object per
// key is the accurate upgrade path (PRD), deliberately not built for v1.
const KV_TTL_SECONDS = 60;

// Negative cache for unknown key hashes (task 25 item 7): a flood of invalid
// keys would otherwise hit D1 on every request (the positive cache never
// populates for a key that doesn't exist). Caching the miss briefly blunts that
// auth-flood D1 cost. Short TTL so any edge case self-heals fast; key creation
// proactively clears it (clearNegativeKeyCache) so a just-minted key is never
// shadowed by a prior probe of the same hash (astronomically unlikely anyway).
const NEGATIVE_TTL_SECONDS = 30;

// Second-tier in-isolate cache behind KV: lets a key this isolate resolved
// recently keep authenticating through a brief D1 outage on a KV miss (KV TTL is
// 60s; this is longer). Consulted ONLY when D1 errors, so normal revocation
// (KV delete → D1 re-read → sees revoked_at) is unaffected. Bounded to cap memory.
const ISOLATE_TTL_MS = 5 * 60 * 1000;
const ISOLATE_MAX = 500;
const isolateCache = new Map<string, { record: KeyRecord; exp: number }>();

// Revocation tombstone (task 25 item 2): the ONLY thing that can make the
// isolate-cache fallback authenticate a stale key is a revocation that happened
// on another isolate during a D1 outage. On revoke we write this KV marker
// (TTL > ISOLATE_TTL) and the fallback consults it, so a revoked key can't ride
// the isolate cache past its revocation even while D1 is down (as long as KV is up).
const REVOKED_TOMBSTONE_TTL_SECONDS = 6 * 60;

export const keyCacheKey = (hash: string): string => `key:${hash}`;
const negativeKeyCacheKey = (hash: string): string => `keyneg:${hash}`;
const revokedTombstoneKey = (hash: string): string => `keyrevoked:${hash}`;

/**
 * Invalidate all caches for a key on revocation: drop the positive KV entry and
 * write a short-lived tombstone so the D1-outage isolate-cache fallback can't
 * resurrect it. Call this from every revoke path instead of a bare KV delete.
 */
export async function invalidateKeyCache(env: CloudflareBindings, hash: string): Promise<void> {
  isolateCache.delete(hash);
  await Promise.all([
    env.CACHE.delete(keyCacheKey(hash)),
    env.CACHE.put(revokedTombstoneKey(hash), '1', {
      expirationTtl: REVOKED_TOMBSTONE_TTL_SECONDS,
    }),
  ]);
}

/** Clear a negative-cache entry — call on key creation so a fresh key resolves. */
export async function clearNegativeKeyCache(env: CloudflareBindings, hash: string): Promise<void> {
  await env.CACHE.delete(negativeKeyCacheKey(hash));
}

async function lookupKey(env: CloudflareBindings, hash: string): Promise<KeyRecord | null> {
  const cached = await env.CACHE.get<KeyRecord>(keyCacheKey(hash), 'json');
  if (cached) return cached;
  // Known-absent key: skip the D1 round-trip (blunts invalid-key floods).
  if (await env.CACHE.get(negativeKeyCacheKey(hash))) return null;

  // Entitlement (plan) and the usage subject come from the ACCOUNT, not the key,
  // so every key under one email shares one plan + quota. INNER JOIN: a key with
  // no linked account (shouldn't exist post-migration 0005) does NOT authenticate
  // — it 401s rather than falling back to an empty, cross-key-shared scope.
  let row: KeyRecord | null;
  try {
    row = await env.DB.prepare(
      `SELECT k.id AS id, k.revoked_at AS revoked_at,
              a.id AS account_id, a.email AS account_email, a.plan AS plan
         FROM api_keys k
         JOIN accounts a ON a.id = k.account_id
        WHERE k.key_hash = ?1`,
    )
      .bind(hash)
      .first<KeyRecord>();
  } catch (err) {
    // D1 blip on a KV miss: serve a recently-seen key from the isolate cache so a
    // transient outage doesn't 500 cold-key auth. But never resurrect a key that
    // was revoked during the outage (tombstone in KV, checked best-effort).
    const fallback = isolateCache.get(hash);
    if (fallback && fallback.exp > Date.now()) {
      try {
        if (await env.CACHE.get(revokedTombstoneKey(hash))) return null;
      } catch {
        // KV also unavailable — fall back to the cached record (best-effort)
      }
      return fallback.record;
    }
    throw err;
  }
  if (!row) {
    try {
      await env.CACHE.put(negativeKeyCacheKey(hash), '1', { expirationTtl: NEGATIVE_TTL_SECONDS });
    } catch {
      // negative-cache write is best-effort
    }
    return null;
  }

  await env.CACHE.put(keyCacheKey(hash), JSON.stringify(row), { expirationTtl: KV_TTL_SECONDS });
  if (isolateCache.size >= ISOLATE_MAX) isolateCache.clear();
  isolateCache.set(hash, { record: row, exp: Date.now() + ISOLATE_TTL_MS });
  return row;
}

// How a caller with no key gets one — REST wording; the MCP route passes its
// own hint naming the tools. Agents read the 401 body, so this is the sign-up
// funnel's first line.
export const NO_KEY_HINT =
  'No key yet? Sign in at /account, or from an agent: POST /v1/auth/agent-signup {"email"} — the user approves one emailed link, then POST /v1/auth/agent-signup/claim returns the key.';

/**
 * Bearer auth: an API key (`fapi_…`, KV hot path, D1 fallback repopulating KV)
 * or an OAuth access token (`gkat_…`, auth/oauth.ts — resolves to the key it
 * was issued for, so everything downstream is identical). Revocation deletes
 * the KV entry; it propagates within the cache TTL. `hint` tells a keyless
 * caller how to get a key (route-specific wording); `resourceMetadata`, when
 * given, is the RFC 9728 pointer OAuth clients need on a 401 to start sign-in
 * (or refresh an expired token) — the MCP route passes it.
 */
export function requireApiKey(
  hint: string = NO_KEY_HINT,
  resourceMetadata?: string,
): MiddlewareHandler<AppEnv> {
  const pointer = resourceMetadata ? `, resource_metadata="${resourceMetadata}"` : '';
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    // RFC 7235 auth-scheme is case-insensitive.
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) {
      return c.json(
        failure(
          'unauthorized',
          `Missing API key. Send it as: Authorization: Bearer <key>. ${hint}`,
        ),
        401,
        // RFC 7235: a 401 MUST say how to authenticate. MCP clients and
        // directory crawlers key off this header.
        { 'WWW-Authenticate': `Bearer realm="gankdat"${pointer}` },
      );
    }

    const presented = match[1]!;
    const hash = await hashKey(presented);
    const record = presented.startsWith(ACCESS_TOKEN_PREFIX)
      ? await resolveAccessToken(c.env, presented, hash)
      : await lookupKey(c.env, hash);
    if (!record || record.revoked_at !== null) {
      const what = presented.startsWith(ACCESS_TOKEN_PREFIX)
        ? 'Expired or revoked access token — refresh it or sign in again'
        : 'Unknown or revoked API key';
      return c.json(failure('unauthorized', what), 401, {
        'WWW-Authenticate': `Bearer realm="gankdat", error="invalid_token"${pointer}`,
      });
    }

    const keyCtx: KeyContext = {
      keyId: record.id,
      accountId: record.account_id,
      plan: record.plan,
      keyHash: hash,
      usageSubject: record.account_email,
    };
    c.set('keyCtx', keyCtx);
    await next();
  };
}
