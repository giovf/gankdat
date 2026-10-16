import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { ODS_FILES, nhsOdsSource, normalizeRow } from '../src/sources/nhs-ods';
import type { NhsOdsRecord } from '../src/sources/nhs-ods';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/nhs-ods';

function load(): Promise<unknown> {
  return refreshD1Source(env, nhsOdsSource);
}

/** Standard 27-column ODS organisation row (no header line in the real files). */
function odsRow(fields: Partial<Record<number, string>>): string {
  const cols = Array.from({ length: 27 }, (_, i) => fields[i + 1] ?? '');
  return cols.map((c) => `"${c}"`).join(',');
}

// Real layout of epraccur: code, name, national grouping, HLHG, five address
// lines, postcode, open/close (YYYYMMDD), status, sub-type, parent, join/left
// parent, telephone (field 18, dropped), …, prescribing setting (field 26).
const FILES: Record<string, string> = {
  etr: [
    odsRow({
      1: 'RJ1',
      2: "GUY'S AND ST THOMAS' NHS FOUNDATION TRUST",
      3: 'Y56',
      4: 'QKK',
      5: 'TRUST OFFICES',
      6: 'GREAT MAZE POND',
      8: 'LONDON',
      9: 'GREATER LONDON',
      10: 'SE1 9RT',
      11: '19930401',
      18: '02071887188',
    }),
    odsRow({
      1: 'RXX',
      2: 'A MERGED TRUST',
      3: 'Y56',
      4: 'QKK',
      5: 'OLD HQ',
      8: 'LONDON',
      10: 'SE1 1AA',
      11: '19930401',
      12: '20200331',
    }),
  ].join('\r\n'),
  ets: [
    odsRow({
      1: 'RJ122',
      2: "ST THOMAS' HOSPITAL",
      3: 'Y56',
      4: 'QKK',
      5: 'WESTMINSTER BRIDGE ROAD',
      8: 'LONDON',
      10: 'SE1 7EH',
      11: '19930401',
      15: 'RJ1',
      16: '19930401',
      18: '02071887188',
    }),
  ].join('\r\n'),
  epraccur: [
    odsRow({
      1: 'A81001',
      2: 'THE DENSHAM SURGERY',
      3: 'Y63',
      4: 'QHM',
      5: 'THE HEALTH CENTRE',
      6: 'LAWSON STREET',
      8: 'STOCKTON-ON-TEES',
      9: 'CLEVELAND',
      10: 'TS18 1HU',
      11: '19740401',
      13: 'A',
      14: 'B',
      15: '16C',
      16: '20200401',
      18: '01642672351',
      22: '0',
      24: '4',
      26: '4',
    }),
    odsRow({
      1: 'A81007',
      2: 'BANKHOUSE SURGERY',
      3: 'Y63',
      4: 'QHM',
      5: 'ALBERT ROAD',
      8: 'MIDDLESBROUGH',
      10: 'TS1 1PY',
      11: '19740401',
      12: '20150331',
      13: 'C',
      14: 'B',
      15: '00M',
      16: '20130401',
      17: '20150331',
      26: '4',
    }),
    odsRow({
      1: 'Y02921',
      2: 'HMP HOLME HOUSE HEALTHCARE',
      3: 'Y63',
      4: 'QHM',
      5: 'HMP HOLME HOUSE',
      8: 'STOCKTON-ON-TEES',
      10: 'TS18 2QU',
      11: '20120401',
      13: 'A',
      14: 'B',
      15: '16C',
      26: '25',
    }),
    odsRow({ 2: 'ROW WITHOUT A CODE', 3: 'Y63' }),
  ].join('\r\n'),
  edispensary: [
    odsRow({
      1: 'FA001',
      2: 'BOOTS',
      3: 'Y63',
      4: 'QHM',
      5: '2 HIGH STREET',
      8: 'STOCKTON-ON-TEES',
      10: 'TS18 1SB',
      11: '19900401',
      13: 'A',
      14: '1',
      15: '16C',
      18: '01642000000',
    }),
  ].join('\r\n'),
  egdpprac: [
    odsRow({
      1: 'V00001',
      2: 'QUEENSWAY DENTAL PRACTICE',
      3: 'Y63',
      4: 'QHM',
      5: '170 QUEENSWAY',
      8: 'BILLINGHAM',
      10: 'TS23 2NT',
      11: '20060401',
      13: 'A',
      14: 'D',
      15: '16C',
    }),
  ].join('\r\n'),
  ephp:
    [
      odsRow({
        1: 'NVC01',
        2: 'NUFFIELD HEALTH TEES HOSPITAL',
        3: 'Y63',
        4: 'QHM',
        5: 'JUNCTION ROAD',
        8: 'STOCKTON-ON-TEES',
        10: 'TS20 1PX',
        11: '20040401',
        13: 'A',
        14: 'H',
      }),
      // A code already seen in another file is kept once (first file wins).
      odsRow({ 1: 'A81001', 2: 'DUPLICATE OF A PRACTICE', 3: 'Y63', 4: 'QHM' }),
    ].join('\r\n') + '\r\n',
};

function fileOf(url: string): string {
  return /[?&]report=([a-z]+)$/.exec(url)?.[1] ?? '';
}

// The service serves each report as a plain CSV attachment (verified 2026-09-24).
function serveFiles(overrides: Record<string, () => Response> = {}): void {
  stubOrigins({
    nhsOds: (url) => {
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

describe('GET /v1/data/nhs-ods', () => {
  it('ingests every ODS file, tags organisation types, normalizes dates and drops telephone numbers', async () => {
    serveFiles();
    await load();
    const res = await authedFetch(`${URL_}?per_page=50`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('02071887188');
    expect(text).not.toContain('01642672351');
    const body = JSON.parse(text) as SuccessEnvelope<NhsOdsRecord[]>;
    // 2 trusts + 1 site + 3 practices (codeless row skipped) + 1 pharmacy + 1 dental + 1 provider (duplicate skipped)
    expect(body.data).toHaveLength(9);
    expect(body.data.find((r) => r.ods_code === 'A81001')).toEqual({
      ods_code: 'A81001',
      name: 'THE DENSHAM SURGERY',
      org_type: 'GP practice',
      status: 'Active',
      national_grouping: 'Y63',
      health_geography: 'QHM',
      address: 'THE HEALTH CENTRE, LAWSON STREET',
      town: 'STOCKTON-ON-TEES',
      county: 'CLEVELAND',
      postcode: 'TS18 1HU',
      outward_code: 'TS18',
      open_date: '1974-04-01',
      close_date: null,
      sub_type: 'B',
      parent_code: '16C',
      parent_joined: '2020-04-01',
      parent_left: null,
      prescribing_setting: 'GP practice',
      ord_url: 'https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations/A81001',
    });
    // Trust files carry no status column: derived from the close date.
    expect(body.data.find((r) => r.ods_code === 'RJ1')).toMatchObject({
      org_type: 'NHS trust',
      status: 'Active',
      prescribing_setting: null,
    });
    expect(body.data.find((r) => r.ods_code === 'RXX')).toMatchObject({
      status: 'Closed',
      close_date: '2020-03-31',
    });
    expect(body.data.find((r) => r.ods_code === 'RJ122')).toMatchObject({
      org_type: 'NHS trust site',
      parent_code: 'RJ1',
    });
    expect(body.data.find((r) => r.ods_code === 'A81007')).toMatchObject({
      status: 'Closed',
      parent_left: '2015-03-31',
    });
    expect(body.data.find((r) => r.ods_code === 'Y02921')?.prescribing_setting).toBe('Prison');
  });

  it('filters by organisation type, status, area codes, parent and dates', async () => {
    serveFiles();
    await load();
    const { key } = await issueKey();
    const codes = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        NhsOdsRecord[]
      >;
      return body.data.map((r) => r.ods_code).sort();
    };
    expect(await codes('org_type=pharmacy')).toEqual(['FA001']);
    expect(await codes('org_type=gp practice&status=active')).toEqual(['A81001', 'Y02921']);
    expect(await codes('health_geography=QKK&org_type=nhs trust site')).toEqual(['RJ122']);
    expect(await codes('parent_code=rj1')).toEqual(['RJ122']);
    expect(await codes('outward_code=ts18')).toEqual(['A81001', 'FA001', 'Y02921']);
    expect(await codes('close_date_after=2019-01-01')).toEqual(['RXX']);
    expect(await codes('prescribing_setting=prison')).toEqual(['Y02921']);
    expect(await codes('q=nuffield')).toEqual(['NVC01']);
  });

  it('fetches each file from the fixed ODS path and loads them all in one generation', async () => {
    serveFiles();
    await load();
    const fetched = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
      fileOf(String(c[0])),
    );
    expect(fetched).toEqual(ODS_FILES.map((f) => f.file));
  });

  it('fails loudly when a later file is missing or reshaped, keeping the previous generation', async () => {
    serveFiles();
    await load();
    vi.unstubAllGlobals();

    serveFiles({ egdpprac: () => new Response('gone', { status: 404 }) });
    await expect(load()).rejects.toThrow('ODS egdpprac download failed: 404');
    vi.unstubAllGlobals();

    const short = '"RJ122","ONLY TWO COLUMNS"\r\n';
    serveFiles({ ets: () => new Response(short, { headers: { 'content-type': 'text/csv' } }) });
    await expect(load()).rejects.toThrow('ODS ets format changed');

    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<NhsOdsRecord[]>;
    expect(body.meta?.total).toBe(9);
  });

  it('falls back to bundled fixtures when the register cannot be read at all', async () => {
    serveFiles({ etr: () => new Response('nope', { status: 404 }) });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<NhsOdsRecord[]>;
    expect(body.meta?.total).toBe(30);
  });
});

describe('normalizeRow', () => {
  it('rejects rows without a plausible ODS code or a name', () => {
    expect(normalizeRow(['', 'NO CODE'], 'GP practice')).toBeNull();
    expect(normalizeRow(['A81001', ''], 'GP practice')).toBeNull();
    expect(normalizeRow(['not a code!', 'X'], 'GP practice')).toBeNull();
  });

  it('keeps an unknown prescribing-setting code as published', () => {
    const cols = Array.from({ length: 27 }, () => '');
    cols[0] = 'A99999';
    cols[1] = 'SOME PRACTICE';
    cols[25] = '99';
    expect(normalizeRow(cols, 'GP practice')?.prescribing_setting).toBe('99');
    expect(normalizeRow(cols, 'Pharmacy')?.prescribing_setting).toBeNull();
  });
});
