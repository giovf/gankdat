import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import fixture from '../src/sources/fixtures/uk-company-profiles.json';
import { cronSources } from '../src/sources/store';
import {
  normalizeCompanyNumber,
  type UkCompanyProfilesRecord,
} from '../src/sources/uk-company-profiles';
import { authedFetch, bearer, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const LOOKUP_URL = 'https://example.com/v1/data/uk-company-profiles';
const MCP_URL = 'https://example.com/mcp';
const [widgets, dissolved] = fixture.companies;

/**
 * Serves the fixture's four resources for its two companies the way the
 * public-data API does: 404 for an unknown company and for a sub-resource the
 * company has none of (charges, PSCs); the search endpoint matches on name.
 */
function companyApi(): (url: string) => Response {
  return (url: string) => {
    const u = new URL(url);
    if (u.pathname === '/search/companies') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const hits = fixture.companies
        .filter((c) => c.profile.company_name.toLowerCase().includes(q))
        .map((c) => ({ company_number: c.profile.company_number, title: c.profile.company_name }));
      return Response.json({ items: hits, total_results: hits.length });
    }
    const m = /^\/company\/([^/]+)(?:\/([a-z-]+))?$/.exec(u.pathname);
    const company = fixture.companies.find((c) => c.profile.company_number === m?.[1]);
    if (!m || !company)
      return new Response('{"errors":[{"error":"company-profile-not-found"}]}', { status: 404 });
    const resource = m[2];
    const body =
      resource === undefined
        ? company.profile
        : resource === 'charges'
          ? company.charges
          : resource === 'filing-history'
            ? company.filing_history
            : resource === 'persons-with-significant-control'
              ? company.pscs
              : undefined;
    if (body === undefined) return new Response('unexpected resource', { status: 500 });
    if (body === null) return new Response('{}', { status: 404 });
    return Response.json(body);
  };
}

async function lookup(
  query: string,
  key?: string,
): Promise<SuccessEnvelope<UkCompanyProfilesRecord[]>> {
  const res = await authedFetch(`${LOOKUP_URL}?${query}`, key);
  expect(res.status).toBe(200);
  return (await res.json()) as SuccessEnvelope<UkCompanyProfilesRecord[]>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-company-profiles (lookup)', () => {
  it('reads the four resources into one organisation-level record (Blind Mode)', async () => {
    const mock = stubOrigins({ companyApi: companyApi() });
    const res = await authedFetch(`${LOOKUP_URL}?company_number=12345678`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Individual PSC, officer name in the filing, charge holders, address lines: never served.
    for (const leak of [
      'Jane',
      'Doe',
      'date_of_birth',
      'officer_name',
      'Example Bank',
      'Edenhall',
      'nationality',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    const body = JSON.parse(text) as SuccessEnvelope<UkCompanyProfilesRecord[]>;
    expect(body.meta).toMatchObject({ source: 'uk-company-profiles', total: 1, page: 1 });
    expect(body.data).toHaveLength(1);
    const record = body.data[0]!;
    expect(record).toMatchObject({
      company_number: '12345678',
      company: 'EXAMPLE WIDGETS LIMITED',
      status: 'active',
      company_type: 'ltd',
      jurisdiction: 'england-wales',
      incorporated_on: '2015-03-02',
      dissolved_on: null,
      sic_codes: ['62012', '62020'],
      previous_names: [{ name: 'EXAMPLE GADGETS LIMITED', ceased_on: '2018-06-01' }],
      locality: 'Manchester',
      postal_code: 'M1 1AA',
      country: 'England',
      accounts_type: 'micro-entity',
      accounts_last_period_end: '2025-03-31',
      accounts_next_due: '2026-12-31',
      accounts_overdue: false,
      confirmation_last_made_up_to: '2026-02-28',
      confirmation_next_due: '2027-03-14',
      confirmation_overdue: false,
      has_charges: true,
      charges_total: 2,
      charges_outstanding: 1,
      charges_satisfied: 1,
      filings_total: 14,
      controllers_active: 2,
      controllers_ceased: 0,
      individual_controllers: 1,
      company_url: 'https://find-and-update.company-information.service.gov.uk/company/12345678',
    });
    expect(record.charges).toEqual([
      {
        charge_code: '123456780002',
        status: 'outstanding',
        classification: 'A registered charge',
        created_on: '2023-06-01',
        satisfied_on: null,
      },
      {
        charge_code: '123456780001',
        status: 'fully-satisfied',
        classification: 'A registered charge',
        created_on: '2017-02-10',
        satisfied_on: '2021-09-30',
      },
    ]);
    expect(record.filings.map((f) => [f.type, f.category, f.description])).toEqual([
      ['CS01', 'confirmation-statement', 'confirmation-statement-with-no-updates'],
      ['AA', 'accounts', 'accounts-with-accounts-type-micro-entity'],
      ['AP01', 'officers', 'appoint-person-director-company-with-name-date'],
    ]);
    expect(record.corporate_controllers).toEqual([
      {
        name: 'EXAMPLE HOLDINGS LTD',
        kind: 'corporate-entity-person-with-significant-control',
        legal_form: 'Private Limited Company',
        country_registered: 'England',
        registration_number: '09876543',
        natures_of_control: [
          'ownership-of-shares-75-to-100-percent',
          'voting-rights-75-to-100-percent',
        ],
        notified_on: '2019-01-15',
        ceased_on: null,
      },
    ]);
    // Profile, charges, filing history, PSCs — and nothing else (officers never called).
    const paths = mock.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(paths.sort()).toEqual([
      '/company/12345678',
      '/company/12345678/charges',
      '/company/12345678/filing-history',
      '/company/12345678/persons-with-significant-control',
    ]);
  });

  it('serves the second lookup of the same company from KV without touching the origin', async () => {
    const mock = stubOrigins({ companyApi: companyApi() });
    const { key } = await issueKey();
    const first = await lookup('company_number=12345678', key);
    const calls = mock.mock.calls.length;
    expect(calls).toBe(4);
    const second = await lookup('company_number=12345678', key);
    expect(mock.mock.calls.length).toBe(calls);
    expect(second.data).toEqual(first.data);
    expect(second.meta?.last_refreshed_at).toBe(first.meta?.last_refreshed_at);
  });

  it('pads short company numbers the way the register writes them', async () => {
    expect(normalizeCompanyNumber('6')).toBe('00000006');
    expect(normalizeCompanyNumber(' sc1234 ')).toBe('SC001234');
    expect(normalizeCompanyNumber('12345678')).toBe('12345678');
    expect(normalizeCompanyNumber('OC301234')).toBe('OC301234');
    const mock = stubOrigins({ companyApi: companyApi() });
    const body = await lookup('company_number=sc123456');
    expect(body.data[0]).toMatchObject({
      company_number: 'SC123456',
      status: 'dissolved',
      dissolved_on: '2024-01-10',
      has_charges: false,
      charges_total: 0,
      charges: [],
      controllers_active: 0,
      individual_controllers: 0,
      corporate_controllers: [],
      filings: [
        {
          type: 'GAZ2',
          category: 'gazette',
          subcategory: 'dissolved',
          date: '2024-01-10',
          description: 'gazette-dissolved-compulsory',
        },
      ],
    });
    expect(mock.mock.calls.some((c) => String(c[0]).includes('/company/SC123456/charges'))).toBe(
      true,
    );
  });

  it('resolves a company name through the search endpoint to its top hit', async () => {
    const mock = stubOrigins({ companyApi: companyApi() });
    const body = await lookup('company=example%20widgets');
    expect(body.data.map((r) => r.company_number)).toEqual(['12345678']);
    const search = mock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes('/search/companies'));
    expect(search).toContain('q=example%20widgets');
    expect(search).toContain('items_per_page=1');
  });

  it('answers an unknown company with an empty page and caches the miss', async () => {
    const mock = stubOrigins({ companyApi: companyApi() });
    const { key } = await issueKey();
    const body = await lookup('company_number=99999999', key);
    expect(body.data).toEqual([]);
    expect(body.meta?.total).toBe(0);
    const calls = mock.mock.calls.length;
    expect(calls).toBe(1);
    await lookup('company_number=99999999', key);
    expect(mock.mock.calls.length).toBe(calls);
    const none = await lookup('company=no%20such%20trading%20name', key);
    expect(none.data).toEqual([]);
  });

  it('requires a key param: a bare query is a 400 naming company_number', async () => {
    stubOrigins({ companyApi: companyApi() });
    const res = await authedFetch(LOOKUP_URL);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('company_number');
    expect(body.error.message).toContain('company_number=00000006');
    const blank = await authedFetch(`${LOOKUP_URL}?company_number=`);
    expect(blank.status).toBe(400);
  });

  it('applies the generic filters to the looked-up record', async () => {
    stubOrigins({ companyApi: companyApi() });
    const { key } = await issueKey();
    const miss = await lookup('company_number=12345678&q=nothing-like-this', key);
    expect(miss.data).toEqual([]);
    const hit = await lookup('company_number=12345678&q=widgets', key);
    expect(hit.data).toHaveLength(1);
  });

  it('falls back to the bundled sample when the origin fails (FIXTURE_FALLBACK)', async () => {
    stubOrigins({ companyApi: () => new Response('boom', { status: 503 }) });
    const body = await lookup('company_number=12345678');
    expect(body.data[0]?.company).toBe(widgets?.profile.company_name);
    const other = await lookup('company_number=SC123456');
    expect(other.data[0]?.company).toBe(dissolved?.profile.company_name);
  });

  it('is never refreshed by the cron waves and has no change feed', async () => {
    expect(cronSources(undefined).map((s) => s.slug)).not.toContain('uk-company-profiles');
    const res = await authedFetch('https://example.com/v1/changes/uk-company-profiles');
    expect(res.status).toBe(404);
  });

  it('lists the lookup keys in the sources listing and serves a public lookup page', async () => {
    const listing = (await (
      await SELF.fetch('https://example.com/v1/data')
    ).json()) as SuccessEnvelope<
      { slug: string; lookup: string[] | null; change_feed: string | null }[]
    >;
    const entry = listing.data.find((s) => s.slug === 'uk-company-profiles');
    expect(entry?.lookup).toEqual(['company_number', 'company']);
    expect(entry?.change_feed).toBeNull();
    expect(listing.data.find((s) => s.slug === 'uk-tenders')?.lookup).toBeNull();
    const page = await SELF.fetch('https://example.com/stats/uk-company-profiles');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('company_number=00000006');
    expect(html).toContain('corporate_controllers');
    expect(html).toContain('"@type":"Dataset"');
    const index = await (await SELF.fetch('https://example.com/stats')).text();
    expect(index).toContain('on-demand lookup');
  });

  it('is an MCP tool that needs its key and answers one record with it', async () => {
    stubOrigins({ companyApi: companyApi() });
    const { key } = await issueKey();
    const call = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await SELF.fetch(MCP_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...bearer(key),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'query_uk_company_profiles', arguments: args },
        }),
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data:')) ?? text;
      return (JSON.parse(line.replace(/^data:/, '')) as { result: Record<string, unknown> }).result;
    };
    const bare = await call({});
    expect(bare.isError).toBe(true);
    expect((bare.content as { text: string }[])[0]?.text).toContain('company_number');
    const found = await call({ company_number: '12345678' });
    expect(found.isError).toBeFalsy();
    const payload = found.structuredContent as {
      data: UkCompanyProfilesRecord[];
      meta: Record<string, unknown>;
    };
    expect(payload.data.map((r) => r.company)).toEqual(['EXAMPLE WIDGETS LIMITED']);
    expect(payload.meta.total).toBe(1);
    expect(payload.meta.credits_remaining).toBeDefined();
  });
});
