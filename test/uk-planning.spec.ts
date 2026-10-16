import {
  createExecutionContext,
  createScheduledController,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import { refreshSource } from '../src/sources/cache';
import type { DataSource } from '../src/sources/types';
import { ukPlanningSource, type UkPlanningRecord } from '../src/sources/uk-planning';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins, tendersResponse } from './helpers/origin-mock';

// Raw origin entities, including personal-data fields that Blind Mode must drop.
const ORIGIN_ENTITIES = [
  {
    entity: 1,
    reference: 'A/1',
    'organisation-entity': 109,
    description: 'Rear extension to dwelling',
    'decision-date': '2023-05-09',
    'entry-date': '2025-05-30',
    'start-date': '2023-01-12',
    'end-date': '',
    point: 'POINT (-0.75 52.04)',
    'applicant-name': 'John Smith',
    'agent-email': 'agent@example.com',
  },
  {
    entity: 2,
    reference: 'B/2',
    'organisation-entity': 222,
    description: 'Solar panel installation',
    'decision-date': '2024-06-30',
    'entry-date': '2025-06-14',
    'start-date': '2024-03-21',
    'end-date': '',
    point: '',
  },
];

function mockOrigin(handler: () => Response): ReturnType<typeof vi.fn> {
  return stubOrigins({ planning: handler });
}

function originPage(): Response {
  return Response.json({ entities: ORIGIN_ENTITIES, links: {}, count: ORIGIN_ENTITIES.length });
}

function originFailure(): Response {
  return new Response('origin exploded', { status: 500 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-planning', () => {
  it('serves normalized records and never exposes personal data (Blind Mode)', async () => {
    mockOrigin(originPage);
    const res = await authedFetch('https://example.com/v1/data/uk-planning');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('John Smith');
    expect(text).not.toContain('agent@example.com');
    const body = JSON.parse(text) as SuccessEnvelope<UkPlanningRecord[]>;
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      entity: 1,
      reference: 'A/1',
      authority: 109,
      description: 'Rear extension to dwelling',
      decision_date: '2023-05-09',
      entry_date: '2025-05-30',
      start_date: '2023-01-12',
      end_date: null,
      point: 'POINT (-0.75 52.04)',
    });
    expect(body.meta?.last_refreshed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes an ok row to refresh_log and caches into KV', async () => {
    mockOrigin(originPage);
    await authedFetch('https://example.com/v1/data/uk-planning');
    const cached = await env.CACHE.get('data:uk-planning', 'json');
    expect(cached).not.toBeNull();
    const rows = await env.DB.prepare(
      "SELECT source_slug, status, records FROM refresh_log WHERE source_slug = 'uk-planning'",
    ).all();
    expect(rows.results).toEqual([{ source_slug: 'uk-planning', status: 'ok', records: 2 }]);
  });

  it('serves the second request from cache without hitting the origin', async () => {
    const mock = mockOrigin(originPage);
    const { key } = await issueKey();
    await authedFetch('https://example.com/v1/data/uk-planning', key);
    const res = await authedFetch('https://example.com/v1/data/uk-planning', key);
    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('filters by authority and decision_date range', async () => {
    mockOrigin(originPage);
    const { key } = await issueKey();
    const res = await authedFetch(
      'https://example.com/v1/data/uk-planning?decision_date_after=2024-01-01',
      key,
    );
    const body = (await res.json()) as SuccessEnvelope<UkPlanningRecord[]>;
    expect(body.data.map((r) => r.reference)).toEqual(['B/2']);

    const res2 = await authedFetch('https://example.com/v1/data/uk-planning?authority=109', key);
    const body2 = (await res2.json()) as SuccessEnvelope<UkPlanningRecord[]>;
    expect(body2.data.map((r) => r.reference)).toEqual(['A/1']);
  });

  it('rejects malformed date params with a 400 envelope', async () => {
    const res = await authedFetch(
      'https://example.com/v1/data/uk-planning?decision_date_after=yesterday',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });

  it('falls back to bundled fixtures when the origin fails (FIXTURE_FALLBACK=true)', async () => {
    mockOrigin(originFailure);
    const res = await authedFetch('https://example.com/v1/data/uk-planning');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkPlanningRecord[]>;
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0]?.reference).toBe('23/00002/FUL');
  });
});

describe('origin emptied (2026-10-10)', () => {
  it('fails loudly with the evidence when the first page answers count 0, never with the bare zero-record text', async () => {
    mockOrigin(() => Response.json({ entities: [], links: {}, count: 0 }));
    await expect(
      ukPlanningSource.fetchFresh({ ...env, FIXTURE_FALLBACK: 'false' }),
    ).rejects.toThrow('origin dataset empty: planning-application answered count 0');
  });

  it('lists the dated notice on /v1/data so a buyer sees why the snapshot is not moving', async () => {
    const res = await authedFetch('https://example.com/v1/data');
    const body = (await res.json()) as SuccessEnvelope<{ slug: string; notice: string | null }[]>;
    const planning = body.data.find((s) => s.slug === 'uk-planning');
    expect(planning?.notice).toContain('Origin paused');
    expect(planning?.notice).toContain('2026-10-10');
    expect(body.data.find((s) => s.slug === 'uk-tenders')?.notice).toBeNull();
  });
});

describe('refreshSource error path', () => {
  it('records an error row and rethrows when fetchFresh fails', async () => {
    const failingSource: DataSource = {
      slug: 'always-broken',
      title: 'Broken',
      description: 'test-only',
      recordSchema: undefined as never,
      queryParams: undefined as never,
      refresh: { cron: '0 5 * * *', cacheTtlSeconds: 60 },
      fetchFresh: () => Promise.reject(new Error('origin exploded')),
    };
    await expect(refreshSource(env, failingSource)).rejects.toThrow('origin exploded');
    const rows = await env.DB.prepare(
      "SELECT status, message FROM refresh_log WHERE source_slug = 'always-broken'",
    ).all();
    expect(rows.results).toEqual([{ status: 'error', message: 'origin exploded' }]);
  });
});

describe('scheduled refresh', () => {
  it('refreshes all sources matching the cron and logs each', async () => {
    stubOrigins({ planning: originPage, tenders: tendersResponse });
    // The daily refresh is split into three staggered triggers (waves); run each.
    for (const cron of ['0 5 * * *', '15 5 * * *', '30 5 * * *', '45 5 * * *']) {
      const controller = createScheduledController({ cron });
      const ctx = createExecutionContext();
      await worker.scheduled(controller, env, ctx);
      await waitOnExecutionContext(ctx);
    }

    expect(await env.CACHE.get('data:uk-planning', 'json')).not.toBeNull();
    expect(await env.CACHE.get('data:uk-tenders', 'json')).not.toBeNull();
    expect(await env.CACHE.get('data:uk-sanctions', 'json')).not.toBeNull();
    expect(await env.CACHE.get('data:eu-ted', 'json')).not.toBeNull();
    // uk-insolvency is runner-fed (refresh.runner): no wave touches it, no row is logged.
    expect(await env.CACHE.get('data:uk-insolvency', 'json')).toBeNull();
    expect(await env.CACHE.get('data:uk-companies', 'json')).not.toBeNull();
    // sam-exclusions is a D1-backed source: its refresh lands in source_meta,
    // not the KV snapshot (fixture fallback: 28 records).
    const samMeta = await env.DB.prepare(
      "SELECT total FROM source_meta WHERE source_slug = 'sam-exclusions'",
    ).first<{ total: number }>();
    expect(samMeta?.total).toBe(28);
    const rows = await env.DB.prepare(
      'SELECT source_slug, status FROM refresh_log ORDER BY source_slug',
    ).all();
    expect(rows.results).toEqual([
      { source_slug: 'eu-ted', status: 'ok' },
      { source_slug: 'sam-exclusions', status: 'ok' },
      { source_slug: 'uk-care-locations', status: 'ok' },
      { source_slug: 'uk-charities', status: 'ok' },
      { source_slug: 'uk-companies', status: 'ok' },
      { source_slug: 'uk-contract-awards', status: 'ok' },
      { source_slug: 'uk-food-hygiene', status: 'ok' },
      { source_slug: 'uk-gambling-operators', status: 'ok' },
      { source_slug: 'uk-planning', status: 'ok' },
      { source_slug: 'uk-sanctions', status: 'ok' },
      { source_slug: 'uk-sponsors', status: 'ok' },
      { source_slug: 'uk-tenders', status: 'ok' },
    ]);
  });
});
