import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { generateKey, hashKey } from '../src/auth/keys';
import { FREE_TIER_CREDITS } from '../src/lib/constants';

const DATA_URL = 'https://example.com/v1/data/uk-tenders';

async function insertKey(accountId: string | null): Promise<string> {
  const key = generateKey();
  await env.DB.prepare(
    'INSERT INTO api_keys (id, key_hash, email, plan, credits_granted, account_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  )
    .bind(
      crypto.randomUUID(),
      await hashKey(key),
      'orphan@example.com',
      'free',
      FREE_TIER_CREDITS,
      accountId,
    )
    .run();
  return key;
}

describe('API-key auth cache (task 25 items 2, 4, 7)', () => {
  it('rejects a key with no linked account — no empty-scope fallback (item 4)', async () => {
    const dangling = await insertKey('no-such-account-id');
    const res = await SELF.fetch(DATA_URL, { headers: { Authorization: `Bearer ${dangling}` } });
    expect(res.status).toBe(401);

    const nullAccount = await insertKey(null);
    const res2 = await SELF.fetch(DATA_URL, {
      headers: { Authorization: `Bearer ${nullAccount}` },
    });
    expect(res2.status).toBe(401);
  });

  it('rejects unknown keys consistently (negative cache is transparent, item 7)', async () => {
    const unknown = `fapi_${'z'.repeat(32)}`;
    const first = await SELF.fetch(DATA_URL, { headers: { Authorization: `Bearer ${unknown}` } });
    // Second hit should be served from the negative cache — same 401 either way.
    const second = await SELF.fetch(DATA_URL, { headers: { Authorization: `Bearer ${unknown}` } });
    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
  });
});
