import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import {
  FILE_ORDER,
  REGISTER_FILES,
  isoDate,
  ukGamblingOperatorsSource,
} from '../src/sources/uk-gambling-operators';
import type { UkGamblingOperatorsRecord } from '../src/sources/uk-gambling-operators';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-gambling-operators';

function load(): Promise<unknown> {
  return refreshD1Source(env, ukGamblingOperatorsSource);
}

function q(cells: string[]): string {
  return cells.map((c) => `"${c}"`).join(',');
}

// Headers as recorded from the live files on 2026-09-24 (values double-quoted,
// blank dates empty). The businesses file carries a BOM.
const FILES: Record<string, string> = {
  [REGISTER_FILES.businesses]: [
    '\uFEFF"Account Number","Licence Account Name"',
    q(['041001', 'Northwind Bookmakers Limited']),
    q(['41002', 'Harbour Casino Group Limited']),
    q(['41004', 'Riverstone Amusements Limited']),
    q(['', 'Row without an account']),
    '',
  ].join('\r\n'),
  [REGISTER_FILES.licences]: [
    q(['Account Number', 'Licence Number', 'Status', 'Type', 'Activity', 'Start Date', 'End Date']),
    // One licence, two activity rows → one record with both activities.
    q([
      '41001',
      '000-041001-R-100001-001',
      'Active',
      'Remote',
      'General Betting Standard - Real Event',
      '02/03/2015',
      '',
    ]),
    q(['41001', '000-041001-R-100001-001', 'Active', 'Remote', 'Pool Betting', '02/03/2015', '']),
    q([
      '41001',
      '000-041001-N-100002-001',
      'Active',
      'Non-Remote',
      'General Betting Standard - Real Event',
      '2008-11-17',
      '',
    ]),
    q(['41002', '000-041002-N-100003-001', 'Active', 'Non-Remote', 'Casino', '01 Sep 2007', '']),
    q([
      '41002',
      '000-041002-R-100004-001',
      'Surrendered',
      'Remote',
      'Casino',
      '10-May-2016',
      '29/02/2024',
    ]),
    // Licence whose operator is not on the businesses file: skipped.
    q(['49999', '000-049999-R-100099-001', 'Active', 'Remote', 'Bingo', '01/01/2020', '']),
  ].join('\r\n'),
  [REGISTER_FILES.tradingNames]: [
    q(['Account Number', 'Trading Name', 'Status']),
    q(['41001', 'Northwind', 'Active']),
    q(['41001', 'Northwind Bet', 'Active']),
    q(['41001', 'Old Northwind', 'Inactive']),
    q(['41002', 'Harbour Casino', 'Active']),
  ].join('\r\n'),
  [REGISTER_FILES.domainNames]: [
    q(['Account Number', 'Domain Name', 'Status']),
    q(['41001', 'NorthwindBet.example', 'Active']),
    q(['41001', 'northwind-casino.example', 'Inactive']),
    q(['41001', 'northwindbet.example', 'Active']), // duplicate after lower-casing
    q(['41002', 'harbourcasino.example', 'Inactive']),
  ].join('\r\n'),
  [REGISTER_FILES.premises]: [
    q([
      'Account Number',
      'Account Name',
      'Premises Activity',
      'Local Authority',
      'Address Line 1',
      'Address Line 2',
      'City',
      'Postcode',
    ]),
    q([
      '41001',
      'Northwind Bookmakers Limited',
      'Betting',
      'Leeds City Council',
      '12 Briggate',
      '',
      'Leeds',
      'LS1 6ER',
    ]),
    q([
      '41001',
      'Northwind Bookmakers Limited',
      'Betting',
      'Birmingham City Council',
      '4 Corporation Street',
      'Unit 2',
      'Birmingham',
      'B2 4LP',
    ]),
    q([
      '41002',
      'Harbour Casino Group Limited',
      'Casino',
      'Portsmouth City Council',
      '1 Gunwharf Quays',
      '',
      'Portsmouth',
      'PO1 3TZ',
    ]),
    // Same premises listed twice: kept once.
    q([
      '41002',
      'Harbour Casino Group Limited',
      'Casino',
      'Portsmouth City Council',
      '1 Gunwharf Quays',
      '',
      'Portsmouth',
      'PO1 3TZ',
    ]),
  ].join('\r\n'),
};

function fileOf(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1);
}

function serveFiles(overrides: Record<string, () => Response> = {}): void {
  stubOrigins({
    gamblingCommission: (url) => {
      const file = fileOf(url);
      const override = overrides[file];
      if (override) return override();
      const body = FILES[file];
      return body !== undefined
        ? new Response(body, { headers: { 'content-type': 'text/csv' } })
        : new Response('not found', { status: 404 });
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-gambling-operators', () => {
  it('joins the five register files into licence, domain and premises records', async () => {
    serveFiles();
    await load();
    const res = await authedFetch(`${URL_}?per_page=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<UkGamblingOperatorsRecord[]>;
    // 4 licences (orphan skipped) + 3 domains (duplicate skipped) + 3 premises (duplicate skipped)
    expect(body.data).toHaveLength(10);
    expect(body.data.find((r) => r.licence_number === '000-041001-R-100001-001')).toEqual({
      id: 'licence:000-041001-R-100001-001',
      record_type: 'licence',
      account_number: '41001',
      operator_name: 'Northwind Bookmakers Limited',
      licence_number: '000-041001-R-100001-001',
      status: 'Active',
      is_active: true,
      licence_type: 'Remote',
      activities: 'General Betting Standard - Real Event|Pool Betting',
      start_date: '2015-03-02',
      end_date: null,
      trading_names: 'Northwind|Northwind Bet',
      domain_name: null,
      local_authority: null,
      address: null,
      city: null,
      postcode: null,
      outward_code: null,
      register_url: 'https://www.gamblingcommission.gov.uk/public-register/business/detail/41001',
    });
    expect(body.data.find((r) => r.licence_number === '000-041002-R-100004-001')).toMatchObject({
      status: 'Surrendered',
      is_active: false,
      start_date: '2016-05-10',
      end_date: '2024-02-29',
      trading_names: 'Harbour Casino',
    });
    expect(body.data.find((r) => r.licence_number === '000-041002-N-100003-001')).toMatchObject({
      start_date: '2007-09-01',
    });
    expect(body.data.find((r) => r.id === 'domain:41001:northwindbet.example')).toEqual({
      id: 'domain:41001:northwindbet.example',
      record_type: 'domain',
      account_number: '41001',
      operator_name: 'Northwind Bookmakers Limited',
      licence_number: null,
      status: 'Active',
      is_active: true,
      licence_type: null,
      activities: null,
      start_date: null,
      end_date: null,
      trading_names: null,
      domain_name: 'northwindbet.example',
      local_authority: null,
      address: null,
      city: null,
      postcode: null,
      outward_code: null,
      register_url: 'https://www.gamblingcommission.gov.uk/public-register/business/detail/41001',
    });
    expect(
      body.data.find((r) => r.id === 'premises:41001:betting:4-corporation-street:b2-4lp'),
    ).toMatchObject({
      record_type: 'premises',
      operator_name: 'Northwind Bookmakers Limited',
      activities: 'Betting',
      local_authority: 'Birmingham City Council',
      address: '4 Corporation Street, Unit 2',
      city: 'Birmingham',
      postcode: 'B2 4LP',
      outward_code: 'B2',
      status: null,
      is_active: true,
    });
    expect(body.data.filter((r) => r.record_type === 'premises')).toHaveLength(3);
    expect(body.data.some((r) => r.account_number === '49999')).toBe(false);
  });

  it('filters by record type, licence type, activity, domain, authority, status and dates', async () => {
    serveFiles();
    await load();
    const { key } = await issueKey();
    const ids = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkGamblingOperatorsRecord[]
      >;
      return body.data.map((r) => r.id).sort();
    };
    // "Inactive" contains "active": the boolean is the precise filter.
    expect(await ids('record_type=domain&is_active=true')).toEqual([
      'domain:41001:northwindbet.example',
    ]);
    expect(await ids('record_type=licence&is_active=false')).toEqual([
      'licence:000-041002-R-100004-001',
    ]);
    expect(await ids('domain_name=harbourcasino.example')).toEqual([
      'domain:41002:harbourcasino.example',
    ]);
    expect(await ids('licence_type=non-remote')).toEqual([
      'licence:000-041001-N-100002-001',
      'licence:000-041002-N-100003-001',
    ]);
    expect(await ids('record_type=licence&activities=pool betting')).toEqual([
      'licence:000-041001-R-100001-001',
    ]);
    expect(await ids('record_type=premises&local_authority=leeds')).toEqual([
      'premises:41001:betting:12-briggate:ls1-6er',
    ]);
    expect(await ids('outward_code=po1')).toEqual([
      'premises:41002:casino:1-gunwharf-quays:po1-3tz',
    ]);
    expect(await ids('status=surrendered')).toEqual(['licence:000-041002-R-100004-001']);
    expect(await ids('end_date_after=2024-01-01')).toEqual(['licence:000-041002-R-100004-001']);
    expect(await ids('start_date_after=2015-01-01&record_type=licence')).toEqual([
      'licence:000-041001-R-100001-001',
      'licence:000-041002-R-100004-001',
    ]);
    expect(await ids('trading_names=northwind bet')).toEqual([
      'licence:000-041001-N-100002-001',
      'licence:000-041001-R-100001-001',
    ]);
    expect(await ids('q=gunwharf')).toEqual(['premises:41002:casino:1-gunwharf-quays:po1-3tz']);
  });

  it('fetches the five files from the fixed download path, in load order', async () => {
    serveFiles();
    await load();
    const fetched = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      fileOf(String(c[0])),
    );
    expect(fetched).toEqual(FILE_ORDER.map((file) => REGISTER_FILES[file]));
  });

  it('fails loudly when a later file is missing or reshaped, keeping the previous generation', async () => {
    serveFiles();
    await load();
    vi.unstubAllGlobals();

    serveFiles({
      [REGISTER_FILES.premises]: () => new Response('gone', { status: 404 }),
    });
    await expect(load()).rejects.toThrow('premises-licence-register.csv download failed: 404');
    vi.unstubAllGlobals();

    const reshaped = '"Account Number","Domain"\r\n"41001","x.example"\r\n';
    serveFiles({
      [REGISTER_FILES.domainNames]: () =>
        new Response(reshaped, { headers: { 'content-type': 'text/csv' } }),
    });
    await expect(load()).rejects.toThrow(
      'business-licence-register-domain-names.csv format changed — missing: Domain Name',
    );

    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkGamblingOperatorsRecord[]
    >;
    expect(body.meta?.total).toBe(10);
  });

  it('falls back to bundled fixtures when the register cannot be read at all', async () => {
    serveFiles({ [REGISTER_FILES.businesses]: () => new Response('nope', { status: 403 }) });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkGamblingOperatorsRecord[]
    >;
    expect(body.meta?.total).toBe(30);
  });
});

describe('isoDate', () => {
  it('normalizes the date layouts the register might use', () => {
    expect(isoDate('02/03/2015')).toBe('2015-03-02');
    expect(isoDate('2/3/2015')).toBe('2015-03-02');
    expect(isoDate('02-03-2015')).toBe('2015-03-02');
    expect(isoDate('2015-03-02')).toBe('2015-03-02');
    expect(isoDate('2015-03-02T00:00:00')).toBe('2015-03-02');
    expect(isoDate('2 Mar 2015')).toBe('2015-03-02');
    expect(isoDate('02-Mar-2015')).toBe('2015-03-02');
    expect(isoDate('2 March 2015')).toBe('2015-03-02');
    expect(isoDate('')).toBeNull();
    expect(isoDate(null)).toBeNull();
    expect(isoDate('n/a')).toBeNull();
  });
});
