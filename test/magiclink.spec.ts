import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { consumeMagicToken, issueMagicToken } from '../src/auth/magiclink';

describe('magic token single-use (task 25 item 3)', () => {
  it('lets exactly one of two concurrent consumers win', async () => {
    const token = await issueMagicToken(env, 'race@example.com');
    // Both fire before either commits — the atomic UPDATE ... WHERE used_at IS
    // NULL must let only one claim the token.
    const [a, b] = await Promise.all([
      consumeMagicToken(env, token),
      consumeMagicToken(env, token),
    ]);
    const winners = [a, b].filter((v) => v === 'race@example.com');
    expect(winners).toHaveLength(1);
    expect([a, b].filter((v) => v === null)).toHaveLength(1);
  });

  it('rejects an expired token', async () => {
    const token = await issueMagicToken(env, 'expired@example.com');
    await env.DB.prepare('UPDATE magic_tokens SET expires_at = ?2 WHERE token = ?1')
      .bind(token, Date.now() - 1000)
      .run();
    expect(await consumeMagicToken(env, token)).toBeNull();
  });

  it('returns null for an unknown token', async () => {
    expect(await consumeMagicToken(env, 'nope')).toBeNull();
    expect(await consumeMagicToken(env, '')).toBeNull();
  });
});
