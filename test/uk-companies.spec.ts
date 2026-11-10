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

  // uk-companies-snapshot-window-cap (2026-11-10): at 2,000 rows the walk stopped inside the
  // second day; the snapshot now holds the whole 7-day window, each day paged to its own count.
  it('walks every day of the window past the old 2,000-row cap, one day at a time', async () => {
    const page = (date: string, from: number, count: number, hits: number): Response =>
      Response.json({
        hits,
        items: Array.from({ length: count }, (_, i) => ({
          company_name: `COMPANY ${date} ${from + i}`,
          company_number: `${date.replaceAll('-', '')}${String(from + i).padStart(5, '0')}`,
          date_of_creation: date,
        })),
      });
    const today = new Date().toISOString().slice(0, 10);
    const daysAgo = (n: number): string =>
      new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    // Day 0: 1,500 companies over two pages (the second one short); days 1–6: 300 each.
    const served: string[] = [];
    let call = 0;
    stubOrigins({
      companies: () => {
        call += 1;
        const date = call <= 2 ? today : daysAgo(call - 2);
        served.push(date);
        if (call === 1) return page(today, 0, 1000, 1500);
        if (call === 2) return page(today, 1000, 500, 1500);
        return page(date, 0, 300, 300);
      },
    });
    const { key } = await issueKey();
    const res = await authedFetch(`${COMPANIES_URL}?per_page=1`, key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkCompaniesRecord[]> & {
      meta: { total: number };
    };
    expect(body.meta.total).toBe(1500 + 6 * 300); // 3,300: past the old cap, the whole window
    expect(call).toBe(8); // 2 pages for day 0, 1 for each of the 6 days after
    expect(served).toEqual([today, today, ...[1, 2, 3, 4, 5, 6].map(daysAgo)]);
    const oldest = (await (
      await authedFetch(`${COMPANIES_URL}?incorporated_on_before=${daysAgo(6)}&per_page=1`, key)
    ).json()) as SuccessEnvelope<UkCompaniesRecord[]> & { meta: { total: number } };
    expect(oldest.meta.total).toBe(300);
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
