import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import fixtureReleases from '../src/sources/fixtures/uk-contract-awards.json';
import type { UkContractAwardsRecord } from '../src/sources/uk-contract-awards';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-contract-awards';

const RELEASE = {
  ocid: 'ocds-b5fd17-test-1',
  id: 'notice-1',
  date: '2026-09-20T13:08:07+01:00',
  tag: ['award'],
  buyer: { id: 'GB-SRS-abc', name: 'AMEY DEFENCE SERVICES LIMITED' },
  parties: [
    {
      name: 'Zenith Developments Group',
      id: 'GB-COH-10135058',
      roles: ['supplier'],
      contactPoint: { name: 'Jane Secret', email: 'jane@example.org', telephone: '07700 900000' },
    },
  ],
  tender: {
    title: 'Whole house refurbishments',
    description: 'D'.repeat(600),
    procurementMethod: 'open',
    mainProcurementCategory: 'works',
    classification: { scheme: 'CPV', id: '45262690' },
    items: [
      { classification: { id: '45262690' }, additionalClassifications: [{ id: '45000000' }] },
    ],
  },
  awards: [
    {
      id: 'award-1',
      status: 'active',
      date: '2026-09-09T00:00:00+01:00',
      value: { amount: 2899918.94, currency: 'GBP' },
      suppliers: [
        { id: 'GB-COH-10135058', name: 'Zenith Developments Group' },
        { id: 'GB-COH-1234567', name: 'Second Winner Ltd' },
      ],
      contractPeriod: {
        startDate: '2026-10-12T00:00:00+01:00',
        endDate: '2027-04-09T23:59:59+01:00',
      },
    },
  ],
};

function packageOf(releases: unknown[]): Response {
  return Response.json({
    license: 'http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
    releases,
    links: {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-contract-awards', () => {
  it('flattens one row per award supplier and never copies party contact details', async () => {
    stubOrigins({ contractsFinder: () => packageOf([RELEASE]) });
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('Jane Secret');
    expect(text).not.toContain('jane@');
    expect(text).not.toContain('07700');
    const body = JSON.parse(text) as SuccessEnvelope<UkContractAwardsRecord[]>;
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({
      ocid: 'ocds-b5fd17-test-1',
      notice_id: 'notice-1',
      award_id: 'award-1',
      title: 'Whole house refurbishments',
      description: 'D'.repeat(400),
      buyer: 'AMEY DEFENCE SERVICES LIMITED',
      buyer_id: 'GB-SRS-abc',
      supplier: 'Zenith Developments Group',
      supplier_id: 'GB-COH-10135058',
      supplier_company_number: '10135058',
      award_status: 'active',
      award_value_amount: 2899918.94,
      award_value_currency: 'GBP',
      award_date: '2026-09-09T00:00:00+01:00',
      contract_start: '2026-10-12T00:00:00+01:00',
      contract_end: '2027-04-09T23:59:59+01:00',
      cpv_codes: ['45262690', '45000000'],
      category: 'works',
      procurement_method: 'open',
      published_at: '2026-09-20T13:08:07+01:00',
    });
    expect(body.data[1]?.supplier_company_number).toBe('01234567');
  });

  it('filters by supplier, buyer, CPV, value and award date', async () => {
    stubOrigins({ contractsFinder: () => packageOf(fixtureReleases as unknown[]) });
    const { key } = await issueKey();
    const all = (await (await authedFetch(URL_, key)).json()) as SuccessEnvelope<
      UkContractAwardsRecord[]
    >;
    expect(all.meta?.total).toBeGreaterThan(5);
    const first = all.data[0]!;
    const bySupplier = (await (
      await authedFetch(`${URL_}?supplier=${encodeURIComponent(first.supplier.slice(0, 8))}`, key)
    ).json()) as SuccessEnvelope<UkContractAwardsRecord[]>;
    expect(
      bySupplier.data.every((r) =>
        r.supplier.toLowerCase().includes(first.supplier.slice(0, 8).toLowerCase()),
      ),
    ).toBe(true);
    const big = (await (
      await authedFetch(`${URL_}?award_value_amount_min=1000000`, key)
    ).json()) as SuccessEnvelope<UkContractAwardsRecord[]>;
    expect(big.data.every((r) => (r.award_value_amount ?? 0) >= 1000000)).toBe(true);
    const future = (await (
      await authedFetch(`${URL_}?award_date_after=2099-01-01`, key)
    ).json()) as SuccessEnvelope<UkContractAwardsRecord[]>;
    expect(future.meta?.total).toBe(0);
  });

  it('falls back to bundled fixtures when the origin fails', async () => {
    stubOrigins({ contractsFinder: () => new Response('nope', { status: 503 }) });
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkContractAwardsRecord[]>;
    expect(body.meta?.total).toBeGreaterThan(5);
  });
});
