import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import fixtureNotices from '../src/sources/fixtures/eu-ted.json';
import { tedRetry } from '../src/sources/eu-ted';
import type { EuTedRecord } from '../src/sources/eu-ted';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const EU_TED_URL = 'https://example.com/v1/data/eu-ted';

function searchResponse(notices: unknown[] = fixtureNotices): Response {
  return Response.json({ notices, totalNoticeCount: notices.length });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/eu-ted', () => {
  it('normalizes eForms notices: english pick, date trim, dedup, url', async () => {
    stubOrigins({ euTed: searchResponse });
    const res = await authedFetch(EU_TED_URL);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Raw multilingual maps and eForms keys never reach the response.
    expect(text).not.toContain('buyer-name');
    expect(text).not.toContain('notice-title');
    const body = JSON.parse(text) as SuccessEnvelope<EuTedRecord[]>;
    const first = body.data.find((r) => r.publication_number === '479648-2026');
    expect(first).toBeDefined();
    // No english buyer name published for this notice → original language.
    expect(first).toMatchObject({
      buyer:
        'Secretaría General de la Agencia Estatal Consejo Superior de Investigaciones Científicas',
      buyer_country: 'ESP',
      notice_type: 'cn-standard',
      procedure_type: 'open',
      contract_nature: 'supplies',
      cpv_codes: ['31712100'],
      places_of_performance: ['ES511', 'ESP'],
      value_amount: 13505424,
      value_currency: 'EUR',
      published_at: '2026-07-10',
      deadline_at: '2026-09-09',
      notice_url: 'https://ted.europa.eu/en/notice/-/detail/479648-2026',
    });
    expect(first?.title).toContain('Spain');
  });

  it('handles notices without value or deadlines', async () => {
    stubOrigins({ euTed: searchResponse });
    const res = await authedFetch(EU_TED_URL);
    const body = (await res.json()) as SuccessEnvelope<EuTedRecord[]>;
    const swedish = body.data.find((r) => r.publication_number === '479647-2026');
    expect(swedish).toMatchObject({
      buyer_country: 'SWE',
      value_amount: 12000000,
      value_currency: 'SEK',
      deadline_at: null,
    });
  });

  it('filters by numeric range, cpv array element, country, and date range', async () => {
    stubOrigins({ euTed: searchResponse });
    const { key } = await issueKey();

    const highValue = (await (
      await authedFetch(`${EU_TED_URL}?value_amount_min=13000000&per_page=50`, key)
    ).json()) as SuccessEnvelope<EuTedRecord[]>;
    expect(highValue.data.map((r) => r.publication_number)).toEqual([
      '479648-2026',
      '479633-2026',
      '479624-2026',
    ]);

    const byCpv = (await (
      await authedFetch(`${EU_TED_URL}?cpv_codes=31712100`, key)
    ).json()) as SuccessEnvelope<EuTedRecord[]>;
    expect(byCpv.data.map((r) => r.publication_number)).toEqual(['479648-2026']);

    const bySweden = (await (
      await authedFetch(`${EU_TED_URL}?buyer_country=SWE`, key)
    ).json()) as SuccessEnvelope<EuTedRecord[]>;
    expect(bySweden.data.map((r) => r.publication_number)).toEqual(['479647-2026']);

    const none = (await (
      await authedFetch(`${EU_TED_URL}?published_at_before=2026-07-09`, key)
    ).json()) as SuccessEnvelope<EuTedRecord[]>;
    expect(none.data).toEqual([]);
  });

  it('retries a throttled page with a pause and reads it once TED answers', async () => {
    let calls = 0;
    stubOrigins({
      euTed: () =>
        (calls += 1) < 3
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
          : searchResponse(),
    });
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    try {
      const res = await authedFetch(EU_TED_URL);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SuccessEnvelope<EuTedRecord[]>;
      expect(body.data.length).toBeGreaterThan(0);
    } finally {
      vi.stubGlobal('setTimeout', realSetTimeout);
    }
    expect(calls).toBe(3);
    // Retry-After of 1 s is honoured on both pauses (under the cap), not the growing default.
    expect(delays.filter((d) => d === 1000).length).toBe(2);
  });

  it('gives up after the retries and falls back when TED keeps throttling', async () => {
    let calls = 0;
    stubOrigins({
      euTed: () => {
        calls += 1;
        return new Response('slow down', { status: 429 });
      },
    });
    const saved = tedRetry.delayMs;
    tedRetry.delayMs = 0;
    try {
      const res = await authedFetch(EU_TED_URL);
      expect(res.status).toBe(200);
    } finally {
      tedRetry.delayMs = saved;
    }
    expect(calls).toBe(4);
  });

  it('falls back to bundled fixtures when the origin fails', async () => {
    stubOrigins({ euTed: () => new Response('origin exploded', { status: 500 }) });
    const res = await authedFetch(EU_TED_URL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<EuTedRecord[]>;
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('rejects malformed date params with a 400 envelope', async () => {
    const res = await authedFetch(`${EU_TED_URL}?published_at_after=last-week`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });
});
