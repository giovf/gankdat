import { env, SELF } from 'cloudflare:test';
import { generateKey, hashKey } from '../../src/auth/keys';
import { FREE_TIER_CREDITS } from '../../src/lib/constants';

export interface IssuedKey {
  id: string;
  key: string;
  /** The email the key was issued under — the usage-counter subject. */
  email: string;
}

// Unique default email per call so keyless issueKey()/authedFetch() calls get
// independent quotas (usage is now metered per-email, not per-key).
let issueSeq = 0;

/**
 * Test fixture: mint an account + key directly in D1, mirroring what
 * POST /v1/account/keys does. Public issuance (POST /v1/keys) is retired —
 * real key creation requires a signed-in session, which auth-session.spec
 * exercises end-to-end; everything else just needs a working key fast.
 */
export async function issueKey(email = `user${(issueSeq += 1)}@example.com`): Promise<IssuedKey> {
  const normalized = email.trim().toLowerCase();
  await env.DB.prepare(
    'INSERT INTO accounts (id, email) VALUES (?1, ?2) ON CONFLICT (email) DO NOTHING',
  )
    .bind(crypto.randomUUID(), normalized)
    .run();
  const account = await env.DB.prepare('SELECT id, plan FROM accounts WHERE email = ?1')
    .bind(normalized)
    .first<{ id: string; plan: string }>();
  if (!account) throw new Error(`account upsert failed for ${normalized}`);

  const id = crypto.randomUUID();
  const key = generateKey();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO api_keys (id, key_hash, email, plan, credits_granted, account_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind(id, await hashKey(key), normalized, account.plan, FREE_TIER_CREDITS, account.id),
    env.DB.prepare(
      'INSERT INTO credit_ledger (account_id, key_id, delta, reason) VALUES (?1, ?2, ?3, ?4)',
    ).bind(account.id, id, FREE_TIER_CREDITS, 'free_tier'),
  ]);
  return { id, key, email: normalized };
}

export function bearer(key: string): HeadersInit {
  return { Authorization: `Bearer ${key}` };
}

/** Convenience for authed GETs against the worker under test. */
export async function authedFetch(url: string, key?: string): Promise<Response> {
  const issued = key ?? (await issueKey()).key;
  return SELF.fetch(url, { headers: bearer(issued) });
}
