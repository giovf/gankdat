import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import fixtureItems from '../src/sources/fixtures/uk-companies.json';
import type { UkCompaniesRecord } from '../src/sources/uk-companies';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const COMPANIES_URL = 'https://example.com/v1/data/uk-companies';

/** First day-request serves the fixture; later window days are empty. */
function dayAwareSearch(): () => Response {
  let call = 0;
  return () => {
    call += 1;
    const items = call === 1 ? fixtureItems : [];
    return Response.json({ hits: items.length, items });
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-companies', () => {
  it('normalizes items and drops address lines (minimization)', async () => {
    stubOrigins({ companies: dayAwareSearch() });
    const res = await authedFetch(COMPANIES_URL);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('address_line');
    expect(text).not.toContain('Edenhall'); // the fixture's street address
    const body = JSON.parse(text) as SuccessEnvelope<UkCompaniesRecord[]>;
    expect(body.data).toHaveLength(25);
    expect(body.data[0]).toEqual({
      company_number: '17329381',
      company: 'URBANWRAP LIVERPOOL LIMITED',
      status: 'active',
      company_type: 'ltd',
      incorporated_on: '2026-07-09',
      sic_codes: ['71111', '74100'],
      locality: 'Liverpool',
      region: null,
      postal_code: 'L25 5NF',
      country: 'England',
      company_url: 'https://find-and-update.company-information.service.gov.uk/company/17329381',
    });
  });

  it('filters by name, sic code element, locality, and date range', async () => {
    stubOrigins({ companies: dayAwareSearch() });
    const { key } = await issueKey();

    const byName = (await (
      await authedFetch(`${COMPANIES_URL}?company=urbanwrap`, key)
    ).json()) as SuccessEnvelope<UkCompaniesRecord[]>;
    expect(byName.data.map((r) => r.company_number)).toEqual(['17329381']);

    const bySic = (await (
      await authedFetch(`${COMPANIES_URL}?sic_codes=71111`, key)
    ).json()) as SuccessEnvelope<UkCompaniesRecord[]>;
    expect(bySic.data.some((r) => r.company_number === '17329381')).toBe(true);
    expect(bySic.data.every((r) => r.sic_codes.includes('71111'))).toBe(true);

    const byLocality = (await (
      await authedFetch(`${COMPANIES_URL}?locality=liverpool`, key)
    ).json()) as SuccessEnvelope<UkCompaniesRecord[]>;
    expect(byLocality.data.every((r) => r.locality === 'Liverpool')).toBe(true);

    const none = (await (
      await authedFetch(`${COMPANIES_URL}?incorporated_on_before=2000-01-01`, key)
    ).json()) as SuccessEnvelope<UkCompaniesRecord[]>;
    expect(none.data).toEqual([]);
  });

  it('falls back to bundled fixtures when the origin fails', async () => {
    stubOrigins({ companies: () => new Response('boom', { status: 500 }) });
    const res = await authedFetch(COMPANIES_URL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkCompaniesRecord[]>;
    expect(body.data).toHaveLength(25);
  });

  it('rejects malformed date params with a 400 envelope', async () => {
    const res = await authedFetch(`${COMPANIES_URL}?incorporated_on_after=recently`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });
});
