// Agent-side sign-up (build routine 2026-09-25). The paywall's biggest audience
// is AI agents that cannot complete a browser magic-link flow, so they can now
// start sign-up themselves: hand over the user's email, get back a request id,
// a claim secret and a short approval code; the user approves ONE emailed link
// (shown the same code, so a stranger's request for their address is obvious),
// and the agent collects a key with the claim secret. Modelled on the OAuth
// device flow (RFC 8628): the code is the human's cross-check, the claim
// secret is the agent's capability, and each is useless without the other.
//
// Security posture, mirroring magic links: the approval link is consumed by a
// same-origin POST (a GET only renders the confirm page, so mail scanners
// cannot approve), approval and claim are single-use via atomic UPDATE ...
// WHERE ... IS NULL, the raw key is minted at claim time and never stored, the
// claim secret is stored hashed, and a key issued this way inherits the
// account's plan exactly like one made in the dashboard — which is why the
// human, not the agent, approves.

import { getOrCreateAccount, normalizeEmail } from './accounts';
import { generateKey, hashKey } from './keys';
import { clearNegativeKeyCache } from './middleware';
import { FREE_TIER_CREDITS } from '../lib/constants';

/** The user has this long to click the emailed link. */
export const APPROVE_TTL_MS = 30 * 60 * 1000;
/** After approval the agent has this long to collect the key. */
export const CLAIM_TTL_MS = 24 * 3600 * 1000;
/** Claimed rows are kept this long — the "keys issued via the agent path" proof number. */
const CLAIMED_RETENTION_MS = 30 * 24 * 3600 * 1000;
const MAX_ACTIVE_KEYS = 25;
/** Sane poll interval for agents waiting on the human; sent back on every pending claim. */
export const CLAIM_RETRY_SECONDS = 15;

/** Same per-IP budget as browser login; both routes (REST and MCP) share the KV scope. */
export const SIGNUP_RATE_LIMIT = { scope: 'signup', limit: 5, windowSeconds: 900 } as const;

// No 0/O/1/I: the code is read off a screen and compared by eye.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function approvalCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

export interface AgentSignupRequest {
  request_id: string;
  claim_secret: string;
  code: string;
  email: string;
  /** ISO timestamp by which the user must approve. */
  approve_by: string;
}

/**
 * Open a sign-up request. Returns what the agent keeps plus the approval token
 * that goes ONLY into the email (never to the agent — otherwise the agent could
 * approve its own request).
 */
export async function createAgentSignup(
  env: CloudflareBindings,
  emailRaw: string,
  clientName: string | null,
): Promise<{ request: AgentSignupRequest; approveToken: string }> {
  const email = normalizeEmail(emailRaw);
  const now = Date.now();
  // Opportunistic sweep (bounded: the request path is rate-limited): unapproved
  // requests past their deadline, approved ones past the claim window, claimed
  // ones past the retention window.
  await env.DB.prepare(
    `DELETE FROM agent_signups
      WHERE (approved_at IS NULL AND expires_at < ?1)
         OR (approved_at IS NOT NULL AND claimed_at IS NULL AND approved_at < ?2)
         OR (claimed_at IS NOT NULL AND claimed_at < ?3)`,
  )
    .bind(now, now - CLAIM_TTL_MS, now - CLAIMED_RETENTION_MS)
    .run();

  const id = crypto.randomUUID();
  const claimSecret = `fsig_${randomHex(32)}`;
  const approveToken = randomHex(32);
  const code = approvalCode();
  const expiresAt = now + APPROVE_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO agent_signups (id, claim_hash, approve_token, email, code, client_name, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, await hashKey(claimSecret), approveToken, email, code, clientName, now, expiresAt)
    .run();
  return {
    request: {
      request_id: id,
      claim_secret: claimSecret,
      code,
      email,
      approve_by: new Date(expiresAt).toISOString(),
    },
    approveToken,
  };
}

export interface PendingApproval {
  email: string;
  code: string;
  client_name: string | null;
}

/** What the approval page shows before the user commits (read-only; nothing is consumed). */
export async function peekAgentSignup(
  env: CloudflareBindings,
  approveToken: string,
): Promise<PendingApproval | null> {
  if (!approveToken) return null;
  return env.DB.prepare(
    'SELECT email, code, client_name FROM agent_signups WHERE approve_token = ?1 AND approved_at IS NULL AND expires_at > ?2',
  )
    .bind(approveToken, Date.now())
    .first<PendingApproval>();
}

/**
 * The user's click: single-use and atomic (row-count decides), creates the
 * account if the email is new. Returns null when the link is unknown, expired
 * or already used.
 */
export async function approveAgentSignup(
  env: CloudflareBindings,
  approveToken: string,
): Promise<PendingApproval | null> {
  if (!approveToken) return null;
  const row = await env.DB.prepare(
    'UPDATE agent_signups SET approved_at = ?2 WHERE approve_token = ?1 AND approved_at IS NULL AND expires_at > ?2 RETURNING email, code, client_name',
  )
    .bind(approveToken, Date.now())
    .first<PendingApproval>();
  if (!row) return null;
  await getOrCreateAccount(env, row.email);
  return row;
}

export type ClaimResult =
  | { status: 'pending'; approve_by: string }
  | { status: 'approved'; api_key: string; key_id: string; plan: string; email: string }
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'claimed' }
  | { status: 'key_limit' };

interface SignupRow {
  id: string;
  email: string;
  client_name: string | null;
  expires_at: number;
  approved_at: number | null;
  claimed_at: number | null;
}

/**
 * The agent's poll. Mints the key on the first call after approval (raw key
 * returned exactly once); every later call reports `claimed`.
 */
export async function claimAgentKey(
  env: CloudflareBindings,
  requestId: string,
  claimSecret: string,
): Promise<ClaimResult> {
  if (!requestId || !claimSecret) return { status: 'not_found' };
  const row = await env.DB.prepare(
    'SELECT id, email, client_name, expires_at, approved_at, claimed_at FROM agent_signups WHERE id = ?1 AND claim_hash = ?2',
  )
    .bind(requestId, await hashKey(claimSecret))
    .first<SignupRow>();
  if (!row) return { status: 'not_found' };
  const now = Date.now();
  if (row.claimed_at !== null) return { status: 'claimed' };
  if (row.approved_at === null) {
    return row.expires_at > now
      ? { status: 'pending', approve_by: new Date(row.expires_at).toISOString() }
      : { status: 'expired' };
  }
  if (row.approved_at + CLAIM_TTL_MS < now) return { status: 'expired' };

  const account = await getOrCreateAccount(env, row.email);
  const { count } = (await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM api_keys WHERE account_id = ?1 AND revoked_at IS NULL',
  )
    .bind(account.id)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= MAX_ACTIVE_KEYS) return { status: 'key_limit' };

  // Win the claim first (atomic), then mint: two concurrent polls can't both
  // walk away with a key.
  const keyId = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    'UPDATE agent_signups SET claimed_at = ?2, key_id = ?3 WHERE id = ?1 AND claimed_at IS NULL',
  )
    .bind(row.id, now, keyId)
    .run();
  if (claimed.meta.changes === 0) return { status: 'claimed' };

  const key = generateKey();
  const hash = await hashKey(key);
  const name = `agent:${(row.client_name ?? 'mcp').slice(0, 60)}`;
  await env.DB.prepare(
    'INSERT INTO api_keys (id, key_hash, email, name, plan, credits_granted, account_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
  )
    .bind(keyId, hash, row.email, name, account.plan, FREE_TIER_CREDITS, account.id)
    .run();
  await clearNegativeKeyCache(env, hash);
  return { status: 'approved', api_key: key, key_id: keyId, plan: account.plan, email: row.email };
}
