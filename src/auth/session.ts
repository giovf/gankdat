import type { Context, MiddlewareHandler } from 'hono';
import { failure } from '../lib/envelope';
import type { AccountContext, AppEnv } from '../types';

// Browser sessions for the self-serve account page. Opaque 256-bit random id
// stored in KV (CACHE) -> { accountId, email, createdAt, refreshedAt }; the
// cookie value IS the credential (no signing needed). httpOnly + Secure +
// SameSite=Lax gives CSRF protection for state-changing POSTs while allowing
// the magic-link GET to set it. A fresh id is minted at every sign-in
// (createSession), so session fixation is not possible.
//
// Lifetime (task 25 item 9): sessions expire after IDLE_TTL of inactivity (the
// KV TTL, slid forward on activity) AND after ABSOLUTE_TTL regardless of
// activity — so a captured cookie can't be used indefinitely. The slide is
// throttled to at most once per REFRESH_AFTER to avoid a KV write per request.

const IDLE_TTL_SECONDS = 7 * 24 * 3600;
const ABSOLUTE_TTL_MS = 30 * 24 * 3600 * 1000;
const REFRESH_AFTER_MS = 24 * 3600 * 1000;
const COOKIE_NAME = 'fapi_session';
const sessionKey = (sid: string): string => `session:${sid}`;

export interface SessionRecord {
  accountId: string;
  email: string;
  /** Epoch ms of sign-in; enforces the absolute lifetime cap. */
  createdAt?: number;
  /** Epoch ms of the last TTL slide; throttles re-writes. */
  refreshedAt?: number;
}

function newSid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSession(
  env: CloudflareBindings,
  rec: { accountId: string; email: string },
): Promise<string> {
  const sid = newSid();
  const now = Date.now();
  const record: SessionRecord = { ...rec, createdAt: now, refreshedAt: now };
  await env.CACHE.put(sessionKey(sid), JSON.stringify(record), {
    expirationTtl: IDLE_TTL_SECONDS,
  });
  return sid;
}

export async function readSession(
  env: CloudflareBindings,
  sid: string,
): Promise<SessionRecord | null> {
  return env.CACHE.get<SessionRecord>(sessionKey(sid), 'json');
}

export async function destroySession(env: CloudflareBindings, sid: string): Promise<void> {
  await env.CACHE.delete(sessionKey(sid));
}

export function sessionCookie(sid: string): string {
  return `${COOKIE_NAME}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${IDLE_TTL_SECONDS}`;
}

export function clearedSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readSessionCookie(c: Context<AppEnv>): string | null {
  const cookie = c.req.header('Cookie') ?? '';
  const match = new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`).exec(cookie);
  return match ? match[1]! : null;
}

/**
 * Cookie-session auth for account routes. Resolves the current plan from the
 * account row each request (not cached in the session) so a plan change is
 * reflected immediately. Enforces the absolute lifetime cap and slides the idle
 * TTL forward on activity.
 */
export function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sid = readSessionCookie(c);
    const rec = sid ? await readSession(c.env, sid) : null;
    if (!sid || !rec) return c.json(failure('unauthorized', 'Not signed in'), 401);

    const now = Date.now();
    // Absolute cap: a session can't outlive this regardless of activity.
    // Pre-existing sessions without createdAt are adopted (treated as fresh)
    // rather than force-logged-out on deploy.
    const createdAt = rec.createdAt ?? now;
    if (now - createdAt > ABSOLUTE_TTL_MS) {
      await destroySession(c.env, sid);
      c.header('Set-Cookie', clearedSessionCookie());
      return c.json(failure('unauthorized', 'Session expired, sign in again'), 401);
    }

    // Slide the idle TTL forward, throttled so it's not a write per request.
    if (now - (rec.refreshedAt ?? 0) > REFRESH_AFTER_MS) {
      const updated: SessionRecord = { ...rec, createdAt, refreshedAt: now };
      await c.env.CACHE.put(sessionKey(sid), JSON.stringify(updated), {
        expirationTtl: IDLE_TTL_SECONDS,
      });
      c.header('Set-Cookie', sessionCookie(sid));
    }

    const acct = await c.env.DB.prepare('SELECT plan FROM accounts WHERE id = ?1')
      .bind(rec.accountId)
      .first<{ plan: string }>();
    const accountCtx: AccountContext = {
      accountId: rec.accountId,
      email: rec.email,
      plan: acct?.plan ?? 'free',
    };
    c.set('accountCtx', accountCtx);
    await next();
  };
}
