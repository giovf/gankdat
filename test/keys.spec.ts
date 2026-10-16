import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKey, hashKey } from '../src/auth/keys';
import type { ErrorEnvelope } from '../src/lib/envelope';
import { authedFetch, bearer, issueKey } from './helpers/auth';
import { planningResponse, stubOrigins } from './helpers/origin-mock';

const KEYS_URL = 'https://example.com/v1/keys';
const DATA_URL = 'https://example.com/v1/data/uk-planning';

const planningPage = (): Response => planningResponse();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('key primitives', () => {
  it('generates fapi_-prefixed base62 keys with fresh entropy', () => {
    const a = generateKey();
    const b = generateKey();
    expect(a).toMatch(/^fapi_[0-9A-Za-z]{32}$/);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically to 64 hex chars', async () => {
    const h1 = await hashKey('fapi_test');
    const h2 = await hashKey('fapi_test');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('POST /v1/keys (retired)', () => {
  // Public issuance accepted UNVERIFIED emails; since keys inherit the
  // account's plan, that was a privilege leak. Creation now requires a
  // signed-in session (POST /v1/account/keys — covered by auth-session.spec).
  it('is gone (410) and points at the account dashboard', async () => {
    const res = await SELF.fetch(KEYS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dana@example.com' }),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('gone');
    expect(body.error.message).toContain('/account');
  });

  it('the fixture path stores only a hash, never the raw key', async () => {
    const { id, key } = await issueKey('dana@example.com');
    const row = await env.DB.prepare('SELECT key_hash, plan FROM api_keys WHERE id = ?1')
      .bind(id)
      .first<{ key_hash: string; plan: string }>();
    expect(row?.key_hash).toBe(await hashKey(key));
    expect(row?.key_hash).not.toBe(key);
    expect(row?.plan).toBe('free');
  });
});

describe('auth middleware', () => {
  it('rejects missing and unknown keys with 401 envelopes', async () => {
    const missing = await SELF.fetch(DATA_URL);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as ErrorEnvelope).error.code).toBe('unauthorized');

    const unknown = await SELF.fetch(DATA_URL, { headers: bearer('fapi_doesNotExist') });
    expect(unknown.status).toBe(401);
  });

  it('leaves discovery endpoints public', async () => {
    expect((await SELF.fetch('https://example.com/v1/health')).status).toBe(200);
    expect((await SELF.fetch('https://example.com/v1/data')).status).toBe(200);
    expect((await SELF.fetch('https://example.com/openapi.json')).status).toBe(200);
  });

  it('falls back to D1 on KV miss and repopulates the cache', async () => {
    stubOrigins({ planning: planningPage });
    const { key } = await issueKey();
    const hash = await hashKey(key);

    expect((await authedFetch(DATA_URL, key)).status).toBe(200);
    expect(await env.CACHE.get(`key:${hash}`)).not.toBeNull();

    await env.CACHE.delete(`key:${hash}`);
    expect((await authedFetch(DATA_URL, key)).status).toBe(200);
    expect(await env.CACHE.get(`key:${hash}`)).not.toBeNull();
  });
});

describe('revocation', () => {
  it('self-revocation takes effect immediately despite the KV cache', async () => {
    stubOrigins({ planning: planningPage });
    const { key } = await issueKey();
    expect((await authedFetch(DATA_URL, key)).status).toBe(200); // warms KV

    const revoke = await SELF.fetch(KEYS_URL, { method: 'DELETE', headers: bearer(key) });
    expect(revoke.status).toBe(200);

    const after = await authedFetch(DATA_URL, key);
    expect(after.status).toBe(401);
  });

  it('admin revocation requires the token and 404s on unknown ids', async () => {
    const { id, key } = await issueKey();

    const wrongToken = await SELF.fetch(`${KEYS_URL}/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': 'nope' },
    });
    expect(wrongToken.status).toBe(401);

    const ok = await SELF.fetch(`${KEYS_URL}/${id}`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    expect(ok.status).toBe(200);
    expect((await SELF.fetch(DATA_URL, { headers: bearer(key) })).status).toBe(401);

    const missing = await SELF.fetch(`${KEYS_URL}/does-not-exist`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': 'test-admin-token' },
    });
    expect(missing.status).toBe(404);
  });
});
