import { env, SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import { currentPeriod } from '../src/metering/counters';
import { isolateRateLimit, rateLimit } from '../src/metering/ratelimit';
import type { AppEnv } from '../src/types';
import { authedFetch, bearer, issueKey } from './helpers/auth';
import { planningResponse, stubOrigins } from './helpers/origin-mock';

const DATA_URL = 'https://example.com/v1/data/uk-planning?per_page=1';
const USAGE_URL = 'https://example.com/v1/usage';

const planningPage = (): Response => planningResponse();

type UsageBody = SuccessEnvelope<{
  plan: string;
  period: string;
  used: number;
  granted: number;
  remaining: number;
  alerts: string[];
}>;

/** Pre-set a subject's (email's) monthly usage counter to hit thresholds fast. */
async function seedUsage(email: string, used: number): Promise<void> {
  await env.CACHE.put(`usage:${email.toLowerCase()}:${currentPeriod()}`, String(used));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('currentPeriod', () => {
  it('formats yyyymm in UTC', () => {
    expect(currentPeriod(new Date('2026-07-15T10:00:00Z'))).toBe('202607');
    expect(currentPeriod(new Date('2026-12-31T23:59:59Z'))).toBe('202612');
    expect(currentPeriod(new Date('2027-01-01T00:00:00Z'))).toBe('202701'); // year rollover
  });
});

describe('month rollover', () => {
  it('grants a fresh quota each period — an exhausted last month does not carry over', async () => {
    stubOrigins({ planning: planningPage });
    const { key, email } = await issueKey();

    // Exhaust LAST month's counter (the key rolls with the period string).
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    await env.CACHE.put(`usage:${email.toLowerCase()}:${currentPeriod(lastMonth)}`, '250');

    // The current period is untouched: full grant, nothing blocked.
    const usage = (await (
      await SELF.fetch(USAGE_URL, { headers: bearer(key) })
    ).json()) as UsageBody;
    expect(usage.data).toMatchObject({ used: 0, granted: 250, remaining: 250, alerts: [] });

    const res = await authedFetch(DATA_URL, key);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Credits-Remaining')).toBe('249');
  });
});

describe('GET /v1/usage', () => {
  it('shows the free-tier grant with zero usage for a fresh key', async () => {
    const { key } = await issueKey();
    const res = await SELF.fetch(USAGE_URL, { headers: bearer(key) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as UsageBody;
    expect(body.data).toMatchObject({
      plan: 'free',
      used: 0,
      granted: 250,
      remaining: 250,
      alerts: [],
    });
    expect(body.data.period).toMatch(/^\d{6}$/);
  });

  it('is free to call: checking usage never changes usage', async () => {
    const { key } = await issueKey();
    await SELF.fetch(USAGE_URL, { headers: bearer(key) });
    const res = await SELF.fetch(USAGE_URL, { headers: bearer(key) });
    const body = (await res.json()) as UsageBody;
    expect(body.data.used).toBe(0);
  });
});

describe('credit metering on data routes', () => {
  it('decrements X-Credits-Remaining monotonically and matches /v1/usage', async () => {
    stubOrigins({ planning: planningPage });
    const { key } = await issueKey();

    const first = await authedFetch(DATA_URL, key);
    expect(first.headers.get('X-Credits-Limit')).toBe('250');
    expect(first.headers.get('X-Credits-Remaining')).toBe('249');

    const second = await authedFetch(DATA_URL, key);
    expect(second.headers.get('X-Credits-Remaining')).toBe('248');

    const usage = (await (
      await SELF.fetch(USAGE_URL, { headers: bearer(key) })
    ).json()) as UsageBody;
    expect(usage.data).toMatchObject({ used: 2, remaining: 248 });
  });

  it('does not charge failed requests', async () => {
    const { key } = await issueKey();
    const bad = await authedFetch('https://example.com/v1/data/uk-planning?per_page=1000', key);
    expect(bad.status).toBe(400);
    const usage = (await (
      await SELF.fetch(USAGE_URL, { headers: bearer(key) })
    ).json()) as UsageBody;
    expect(usage.data.used).toBe(0);
  });

  it('nudges at 80%, alerts at 100%, and blocks past the quota with 402', async () => {
    stubOrigins({ planning: planningPage });
    const { key, email } = await issueKey();
    await seedUsage(email, 248); // free plan = 250/mo

    const r1 = await authedFetch(DATA_URL, key); // → 249, 80% nudge
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Credits-Remaining')).toBe('1');
    expect(r1.headers.get('X-Upgrade-Nudge')).toBeTruthy();
    expect(((await r1.json()) as SuccessEnvelope<unknown[]>).meta?.usage_alert).toBe('80');

    const r2 = await authedFetch(DATA_URL, key); // → 250, 100% alert
    expect(r2.status).toBe(200);
    expect(r2.headers.get('X-Credits-Remaining')).toBe('0');
    expect(((await r2.json()) as SuccessEnvelope<unknown[]>).meta?.usage_alert).toBe('100');

    const blocked = await authedFetch(DATA_URL, key); // over quota
    expect(blocked.status).toBe(402);
    expect(blocked.headers.get('X-Credits-Remaining')).toBe('0');
    expect(((await blocked.json()) as ErrorEnvelope).error.code).toBe('quota_exceeded');

    const usage = (await (
      await SELF.fetch(USAGE_URL, { headers: bearer(key) })
    ).json()) as UsageBody;
    expect(usage.data).toMatchObject({ used: 250, granted: 250, remaining: 0, alerts: ['100'] });
  });
});

describe('rate limiting', () => {
  it('caps requests in a window and reports Retry-After', async () => {
    const app = new Hono<AppEnv>();
    app.use(
      '*',
      rateLimit({ scope: 'test', limit: 3, windowSeconds: 60, identify: () => 'fixed' }),
    );
    app.get('/ping', (c) => c.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const res = await app.request('/ping', {}, env);
      expect(res.status).toBe(200);
    }
    const limited = await app.request('/ping', {}, env);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = (await limited.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('rate_limited');
  });

  it('fails open when KV errors (daily write cap, outage) instead of 500ing', async () => {
    const app = new Hono<AppEnv>();
    app.use(
      '*',
      rateLimit({ scope: 'test-open', limit: 3, windowSeconds: 60, identify: () => 'fixed' }),
    );
    app.get('/ping', (c) => c.json({ ok: true }));

    const broken = {
      ...env,
      RATE: {
        get: () => Promise.reject(new Error('KV put() limit exceeded')),
        put: () => Promise.reject(new Error('KV put() limit exceeded')),
      } as unknown as KVNamespace,
    };
    // Well past the limit: every request must still succeed.
    for (let i = 0; i < 6; i++) {
      const res = await app.request('/ping', {}, broken);
      expect(res.status).toBe(200);
    }
  });
});

describe('isolateRateLimit', () => {
  it('allows up to the limit, then reports seconds until the window resets', () => {
    for (let i = 0; i < 4; i++) {
      expect(isolateRateLimit('iso-test-a', 4, 60)).toBe(0);
    }
    expect(isolateRateLimit('iso-test-a', 4, 60)).toBeGreaterThan(0);
    // Independent ids get independent windows.
    expect(isolateRateLimit('iso-test-b', 4, 60)).toBe(0);
  });
});
