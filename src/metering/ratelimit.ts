import type { Context, MiddlewareHandler } from 'hono';
import { failure } from '../lib/envelope';
import type { AppEnv } from '../types';

export interface RateLimitOptions {
  /** Namespaces the RATE KV keys, e.g. 'data', 'keys'. */
  scope: string;
  limit: number;
  windowSeconds: number;
  /** What to count by — key id for authed routes, IP for public ones. */
  identify: (c: Context<AppEnv>) => string;
}

/**
 * Sliding-window-counter on the RATE KV namespace: the current bucket plus a
 * time-weighted share of the previous bucket. This bounds the classic
 * fixed-window flaw where up to 2×limit slip through across a bucket boundary
 * (which matters for the anti-abuse limiters, e.g. key issuance). Best-effort by
 * design — KV is eventually consistent; a Durable Object is the accurate upgrade
 * path (PRD), not built for v1.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSeconds / options.windowSeconds);
    const elapsed = nowSeconds % options.windowSeconds;
    const prevWeight = (options.windowSeconds - elapsed) / options.windowSeconds;

    const id = options.identify(c);
    const currKey = `rl:${options.scope}:${id}:${bucket}`;
    const prevKey = `rl:${options.scope}:${id}:${bucket - 1}`;

    // Fail OPEN on any KV error: a limiter outage must never become an API
    // outage. Concretely, the free-tier daily write cap makes RATE.put throw
    // once exhausted — without this, every rate-limited route (including paid
    // data calls) would 500 for the rest of the day.
    let current = 0;
    let estimated = 0;
    try {
      const [currRaw, prevRaw] = await Promise.all([
        c.env.RATE.get(currKey),
        c.env.RATE.get(prevKey),
      ]);
      current = Number(currRaw ?? '0');
      estimated = current + Number(prevRaw ?? '0') * prevWeight;
    } catch {
      // reads unavailable → allow; the window restarts once KV recovers
    }

    if (estimated >= options.limit) {
      c.header('Retry-After', String(options.windowSeconds - elapsed));
      return c.json(
        failure(
          'rate_limited',
          `Rate limit exceeded (${options.limit} per ${options.windowSeconds}s); retry later`,
        ),
        429,
      );
    }
    try {
      await c.env.RATE.put(currKey, String(current + 1), {
        expirationTtl: Math.max(60, options.windowSeconds * 2),
      });
    } catch {
      // count lost, request allowed — acceptable degradation
    }
    await next();
  };
}

// ── In-isolate limiter ──────────────────────────────────────────────────────
// Zero-KV variant for high-volume anonymous traffic (MCP introspection by
// registry/directory crawlers). Per-isolate fixed window: each edge isolate
// counts independently, so the global effective limit is a soft multiple —
// fine for cheap metadata endpoints where the limiter is an abuse valve, not
// an accounting system. Bounded to cap memory (mirrors auth/middleware.ts).
const ISOLATE_BUCKETS_MAX = 1000;
const isolateBuckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Count a hit against an in-isolate fixed window. Returns 0 when allowed, or
 * seconds until the window resets when over the limit.
 */
export function isolateRateLimit(id: string, limit: number, windowSeconds: number): number {
  const now = Date.now();
  const entry = isolateBuckets.get(id);
  if (!entry || entry.resetAt <= now) {
    if (isolateBuckets.size >= ISOLATE_BUCKETS_MAX) isolateBuckets.clear();
    isolateBuckets.set(id, { count: 1, resetAt: now + windowSeconds * 1000 });
    return 0;
  }
  if (entry.count >= limit) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  entry.count += 1;
  return 0;
}
