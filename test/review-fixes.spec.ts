// Regression tests for the code-review fixes.
import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import { readCached, refreshSource } from '../src/sources/cache';
import { ukPlanningSource } from '../src/sources/uk-planning';
import type { DataSource } from '../src/sources/types';
import { authedFetch, bearer, issueKey } from './helpers/auth';
import { planningResponse, stubOrigins, tendersResponse } from './helpers/origin-mock';

const PLANNING_URL = 'https://example.com/v1/data/uk-planning';

afterEach(() => {
  vi.unstubAllGlobals();
});

// #6 — empty-string query params are treated as absent, not as active filters.
describe('empty query params (#6)', () => {
  it('treats ?authority= as no filter instead of authority===0', async () => {
    stubOrigins({
      planning: () =>
        planningResponse([
          { entity: 1, reference: 'A/1', 'organisation-entity': 109, description: 'x' },
          { entity: 2, reference: 'B/2', 'organisation-entity': 222, description: 'y' },
        ]),
    });
    const { key } = await issueKey();
    const res = await authedFetch(`${PLANNING_URL}?authority=`, key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<unknown[]>;
    expect(body.data).toHaveLength(2); // not 0
  });

  it('does not 400 on a bare ?per_page=', async () => {
    stubOrigins({ planning: () => planningResponse() });
    const { key } = await issueKey();
    const res = await authedFetch(`${PLANNING_URL}?per_page=`, key);
    expect(res.status).toBe(200);
    expect(((await res.json()) as SuccessEnvelope<unknown[]>).meta?.per_page).toBe(25);
  });
});

// #7 — a date-only _before bound covers the whole boundary day of a datetime field.
describe('date-range boundary (#7)', () => {
  it('includes same-day datetime records on published_at_before', async () => {
    stubOrigins({
      tenders: () =>
        tendersResponse([
          {
            id: 'n/1',
            ocid: 'ocds-1',
            date: '2026-07-06T16:09:27+01:00',
            tender: { title: 'boundary day' },
          },
        ]),
    });
    const { key } = await issueKey();
    const res = await authedFetch(
      'https://example.com/v1/data/uk-tenders?published_at_before=2026-07-06',
      key,
    );
    const body = (await res.json()) as SuccessEnvelope<{ notice_id: string }[]>;
    expect(body.data.map((r) => r.notice_id)).toEqual(['n/1']);
  });
});

// #13 — the bearer scheme is matched case-insensitively.
describe('bearer scheme case-insensitivity (#13)', () => {
  it('accepts a lowercase scheme', async () => {
    stubOrigins({ planning: () => planningResponse() });
    const { key } = await issueKey();
    const res = await SELF.fetch(PLANNING_URL, {
      headers: { Authorization: `bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });
});

// #16 — HEAD requests are not billed a credit.
describe('HEAD is not metered (#16)', () => {
  it('does not consume credits', async () => {
    stubOrigins({ planning: () => planningResponse() });
    const { key } = await issueKey();
    const head = await SELF.fetch(PLANNING_URL, { method: 'HEAD', headers: bearer(key) });
    expect(head.status).toBe(200);
    const usage = (await (
      await SELF.fetch('https://example.com/v1/usage', { headers: bearer(key) })
    ).json()) as SuccessEnvelope<{ used: number }>;
    expect(usage.data.used).toBe(0);
  });
});

// #9 — free quota is per-email, so multiple keys for one email share it.
describe('per-email quota (#9)', () => {
  it('shares the monthly counter across keys with the same email', async () => {
    stubOrigins({ planning: () => planningResponse() });
    const email = 'shared@example.com';
    const k1 = await issueKey(email);
    const k2 = await issueKey(email);
    await authedFetch(PLANNING_URL, k1.key); // charges 1 against the email

    const usage = (await (
      await SELF.fetch('https://example.com/v1/usage', { headers: bearer(k2.key) })
    ).json()) as SuccessEnvelope<{ used: number }>;
    expect(usage.data.used).toBe(1); // key2 sees key1's usage
  });
});

// #14 — a prototype-chain plan name can't slip past the unknown-plan guard.
describe('checkout plan guard (#14)', () => {
  it('rejects plan="toString" with a 400, not a 500', async () => {
    const { key } = await issueKey();
    const res = await SELF.fetch('https://example.com/v1/billing/checkout', {
      method: 'POST',
      headers: { ...bearer(key), 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'toString' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe('bad_request');
  });
});

// #12 — GET /mcp is not a hanging SSE stream; only POST is handled.
describe('MCP method (#12)', () => {
  it('does not accept GET', async () => {
    const { key } = await issueKey();
    const res = await SELF.fetch('https://example.com/mcp', { headers: bearer(key) });
    expect(res.status).toBe(404);
  });
});

// #3 / #10 — a 0-record refresh is an error, and a good cache is served stale.
describe('cache resilience (#3, #10)', () => {
  it('treats a 0-record refresh as an error', async () => {
    const emptySource = {
      slug: 'always-empty',
      title: 'Empty',
      description: 'test',
      recordSchema: undefined as never,
      queryParams: undefined as never,
      refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
      fetchFresh: () => Promise.resolve([]),
    } satisfies DataSource;
    await expect(refreshSource(env, emptySource)).rejects.toThrow('0 records');
    const row = await env.DB.prepare(
      "SELECT status FROM refresh_log WHERE source_slug = 'always-empty'",
    ).first<{ status: string }>();
    expect(row?.status).toBe('error');
  });

  it('serves the last-known-good payload when a refresh fails', async () => {
    // A stale cached payload (old timestamp) forces a refresh attempt.
    await env.CACHE.put(
      'data:uk-planning',
      JSON.stringify({
        records: [{ reference: 'STALE/1' }],
        last_refreshed_at: '2020-01-01T00:00:00Z',
      }),
    );
    stubOrigins({ planning: () => planningResponse([]) }); // origin now yields nothing
    const payload = await readCached(env, ukPlanningSource);
    expect(payload.records).toEqual([{ reference: 'STALE/1' }]);
  });
});
