import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import fixtureReleases from '../src/sources/fixtures/uk-tenders.json';
import { tendersRetry, type UkTendersRecord } from '../src/sources/uk-tenders';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const TENDERS_URL = 'https://example.com/v1/data/uk-tenders';

function packageResponse(): Response {
  return Response.json({ releases: fixtureReleases, links: {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-tenders', () => {
  it('retries a throttled page, honouring Retry-After, and still serves the day', async () => {
    let calls = 0;
    stubOrigins({
      tenders: () =>
        (calls += 1) < 3
          ? new Response('slow down', { status: 429, headers: { 'retry-after': '1' } })
          : packageResponse(),
    });
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return realSetTimeout(fn, 0);
    }) as typeof setTimeout);
    try {
      const res = await authedFetch(TENDERS_URL);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SuccessEnvelope<UkTendersRecord[]>;
      expect(body.data).toHaveLength(3);
    } finally {
      vi.stubGlobal('setTimeout', realSetTimeout);
    }
    expect(calls).toBe(3);
    // Retry-After of 1 s is honoured on both pauses (under the cap), not the growing default.
    expect(delays.filter((d) => d === 1000).length).toBe(2);
  });

  it('gives up after the retries and falls back when Find a Tender keeps throttling', async () => {
    let calls = 0;
    stubOrigins({
      tenders: () => {
        calls += 1;
        return new Response('slow down', { status: 429 });
      },
    });
    const saved = tendersRetry.delayMs;
    tendersRetry.delayMs = 0;
    try {
      const res = await authedFetch(TENDERS_URL);
      expect(res.status).toBe(200);
    } finally {
      tendersRetry.delayMs = saved;
    }
    expect(calls).toBe(4);
  });

  it('flattens OCDS releases and never exposes contact data (Blind Mode)', async () => {
    stubOrigins({ tenders: packageResponse });
    const res = await authedFetch(TENDERS_URL);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('finance@fixture.example');
    expect(text).not.toContain('contactPoint');
    const body = JSON.parse(text) as SuccessEnvelope<UkTendersRecord[]>;
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toEqual({
      ocid: 'ocds-h6vhtk-060718',
      notice_id: '063318-2026',
      title: 'Facilities Management Open Framework',
      description: 'Framework for facilities management services across academy sites',
      buyer: 'HORNCHURCH ACADEMY TRUST',
      status: 'complete',
      procurement_method: 'open',
      category: 'services',
      cpv_codes: ['79993000', '50700000'],
      value_amount: 1250000,
      value_currency: 'GBP',
      published_at: '2026-07-06T16:09:27+01:00',
      deadline_at: '2026-08-15T12:00:00+01:00',
    });
  });

  it('handles nulls in value, period, and items', async () => {
    stubOrigins({ tenders: packageResponse });
    const res = await authedFetch(TENDERS_URL);
    const body = (await res.json()) as SuccessEnvelope<UkTendersRecord[]>;
    const cabinetOffice = body.data.find((r) => r.buyer === 'Cabinet Office');
    expect(cabinetOffice).toMatchObject({
      value_amount: null,
      value_currency: null,
      deadline_at: null,
      cpv_codes: [],
    });
  });

  it('filters by numeric range, cpv array element, and date range', async () => {
    stubOrigins({ tenders: packageResponse });
    const { key } = await issueKey();

    const highValue = (await (
      await authedFetch(`${TENDERS_URL}?value_amount_min=2000000`, key)
    ).json()) as SuccessEnvelope<UkTendersRecord[]>;
    expect(highValue.data.map((r) => r.notice_id)).toEqual(['063319-2026']);

    const byCpv = (await (
      await authedFetch(`${TENDERS_URL}?cpv_codes=50700000`, key)
    ).json()) as SuccessEnvelope<UkTendersRecord[]>;
    expect(byCpv.data.map((r) => r.notice_id)).toEqual(['063318-2026']);

    const recent = (await (
      await authedFetch(`${TENDERS_URL}?published_at_after=2026-07-05`, key)
    ).json()) as SuccessEnvelope<UkTendersRecord[]>;
    expect(recent.data.map((r) => r.notice_id)).toEqual(['063318-2026', '063319-2026']);
  });

  it('follows links.next cursor pagination until exhausted', async () => {
    let call = 0;
    const mock = stubOrigins({
      tenders: () => {
        call += 1;
        if (call === 1) {
          return Response.json({
            releases: [fixtureReleases[0]],
            links: {
              next: 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?cursor=abc',
            },
          });
        }
        return Response.json({ releases: [fixtureReleases[1]], links: {} });
      },
    });
    const res = await authedFetch(TENDERS_URL);
    const body = (await res.json()) as SuccessEnvelope<UkTendersRecord[]>;
    expect(mock).toHaveBeenCalledTimes(2);
    expect(body.data.map((r) => r.notice_id)).toEqual(['063318-2026', '063319-2026']);
  });

  it('falls back to bundled fixtures when the origin fails', async () => {
    stubOrigins({ tenders: () => new Response('origin exploded', { status: 500 }) });
    const res = await authedFetch(TENDERS_URL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkTendersRecord[]>;
    expect(body.data).toHaveLength(3);
  });

  it('rejects malformed date params with a 400 envelope', async () => {
    const res = await authedFetch(`${TENDERS_URL}?published_at_after=last-week`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });
});
