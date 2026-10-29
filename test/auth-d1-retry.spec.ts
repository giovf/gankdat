import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { generateKey, hashKey } from '../src/auth/keys';
import { requireApiKey } from '../src/auth/middleware';
import { FREE_TIER_CREDITS } from '../src/lib/constants';
import type { AppEnv } from '../src/types';

// A cold key (no KV copy, never seen by this isolate) whose D1 read dies on one transient D1 error
// authenticates on the retry instead of answering 500 (gankdat `apify-companies-house-qa-repair`,
// 2026-10-29: Apify's one-shot QA call hit exactly that — a fresh isolate, one D1 blip, a bare 500).
// A non-transient D1 error is still thrown at once, and a second transient error still throws.

async function insertAccountAndKey(): Promise<string> {
  const accountId = crypto.randomUUID();
  const email = `${accountId}@example.com`;
  await env.DB.prepare('INSERT INTO accounts (id, email, plan) VALUES (?1, ?2, ?3)')
    .bind(accountId, email, 'free')
    .run();
  const key = generateKey();
  await env.DB.prepare(
    'INSERT INTO api_keys (id, key_hash, email, plan, credits_granted, account_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  )
    .bind(crypto.randomUUID(), await hashKey(key), email, 'free', FREE_TIER_CREDITS, accountId)
    .run();
  return key;
}

/** env whose D1 `first()` rejects with each queued error before delegating to the real database. */
function flakyEnv(errors: Error[]): { env: CloudflareBindings; firstCalls: () => number } {
  let calls = 0;
  const queue = [...errors];
  const db = {
    prepare(sql: string) {
      const stmt = env.DB.prepare(sql);
      return {
        bind(...values: unknown[]) {
          const bound = stmt.bind(...values);
          return {
            first: async <T>(col?: string) => {
              calls += 1;
              const err = queue.shift();
              if (err) throw err;
              return (col ? bound.first<T>(col) : bound.first<T>()) as Promise<T | null>;
            },
            run: () => bound.run(),
            all: () => bound.all(),
          };
        },
      };
    },
  };
  return { env: { ...env, DB: db as unknown as D1Database }, firstCalls: () => calls };
}

async function pingOn(bindings: CloudflareBindings, key: string): Promise<Response> {
  const app = new Hono<AppEnv>();
  app.use('*', requireApiKey());
  app.get('/ping', (c) => c.json({ ok: true }));
  app.onError((err, c) => c.json({ error: err.message }, 500));
  return await app.fetch(
    new Request('https://example.com/ping', { headers: { Authorization: `Bearer ${key}` } }),
    bindings,
  );
}

describe('cold-key auth survives one transient D1 error', () => {
  it('retries once on a transient D1 error and authenticates', async () => {
    const key = await insertAccountAndKey();
    const flaky = flakyEnv([
      new Error('D1_ERROR: internal error; reference = pvpjl6o7idm7cdijf25nr275'),
    ]);
    const res = await pingOn(flaky.env, key);
    expect(res.status).toBe(200);
    expect(flaky.firstCalls()).toBe(2);
  });

  it('gives up after a second transient error (500, two reads)', async () => {
    const key = await insertAccountAndKey();
    const flaky = flakyEnv([
      new Error('D1_ERROR: internal error; reference = a'),
      new Error('D1 DB is overloaded. Requests queued for too long.'),
    ]);
    const res = await pingOn(flaky.env, key);
    expect(res.status).toBe(500);
    expect(flaky.firstCalls()).toBe(2);
  });

  it('does not retry a non-transient D1 error', async () => {
    const key = await insertAccountAndKey();
    const flaky = flakyEnv([new Error('D1_ERROR: no such table: api_keys')]);
    const res = await pingOn(flaky.env, key);
    expect(res.status).toBe(500);
    expect(flaky.firstCalls()).toBe(1);
  });
});
