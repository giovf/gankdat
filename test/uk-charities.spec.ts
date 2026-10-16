import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { ukCharitiesSource } from '../src/sources/uk-charities';
import type { UkCharitiesRecord } from '../src/sources/uk-charities';
import { inflateZipEntry } from '../src/sources/zip';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-charities';

function load(): Promise<unknown> {
  return refreshD1Source(env, ukCharitiesSource);
}

const HEADER =
  'date_of_extract\torganisation_number\tregistered_charity_number\tlinked_charity_number\tcharity_name\tcharity_type\tcharity_registration_status\tdate_of_registration\tdate_of_removal\tcharity_reporting_status\tlatest_acc_fin_period_start_date\tlatest_acc_fin_period_end_date\tlatest_income\tlatest_expenditure\tcharity_contact_address1\tcharity_contact_address2\tcharity_contact_address3\tcharity_contact_address4\tcharity_contact_address5\tcharity_contact_postcode\tcharity_contact_phone\tcharity_contact_email\tcharity_contact_web\tcharity_company_registration_number\tcharity_insolvent\tcharity_in_administration\tcharity_previously_excepted\tcharity_is_cdf_or_cif\tcharity_is_cio\tcio_is_dissolved\tdate_cio_dissolution_notice\tcharity_activities\tcharity_gift_aid\tcharity_has_land';
const ROWS = [
  '2026-09-20 00:00:00.0000000\t5001\t1100001\t0\tACME COMMUNITY TRUST\tCIO\tRegistered\t2015-03-02 00:00:00.0000000\t\tSubmission Received\t2025-04-01 00:00:00.0000000\t2026-03-31 00:00:00.0000000\t125000\t118000\t12 Volunteer Lane\tFlat 3\tLeeds\t\t\tLS1 4AB\t07700 900123\tsecretary@example.org\twww.acme-trust.example\t\tFalse\tFalse\t\t\tTrue\tFalse\t\tRuns a community centre and food bank in central Leeds.\tTrue\tFalse',
  '2026-09-20 00:00:00.0000000\t5002\t1100001\t1\tACME TRUST YOUTH WING\t\tRegistered\t2016-01-10 00:00:00.0000000\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tFalse\tFalse\t\t\t\t\t\t\t\t',
  '2026-09-20 00:00:00.0000000\t5003\t1100002\t0\tOLD HALL TRUST\tTrust\tRemoved\t1962-05-17 00:00:00.0000000\t2014-04-16 00:00:00.0000000\tRemoved\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tFalse\tFalse\t\t\tFalse\t\t\t\t\t',
  '2026-09-20 00:00:00.0000000\t5004\t1100003\t0\tBIG HOSPICE LIMITED\tCharitable company\tRegistered\t2001-07-01 00:00:00.0000000\t\tSubmission Received Late\t2024-01-01 00:00:00.0000000\t2024-12-31 00:00:00.0000000\t9800000\t9500000\t\t\t\t\t\tM1 1AA\t\t\t\t04123456\tFalse\tTrue\t\t\tFalse\t\t\t' +
    'X'.repeat(500) +
    '\tTrue\tTrue',
  '2026-09-20 00:00:00.0000000\t\t1100004\t0\tNO ORG NUMBER\t\tRegistered\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\t\tFalse\tFalse\t\t\t\t\t\t\t\t',
];
const TSV = '\uFEFF' + [HEADER, ...ROWS].join('\r\n') + '\r\n';

async function deflateRaw(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** A data-descriptor ZIP (flag 8, sizes 0 in the local header, descriptor + central-dir junk after the data) — the Commission's layout. */
async function dataDescriptorZip(text: string): Promise<Uint8Array> {
  const data = await deflateRaw(text);
  const name = new TextEncoder().encode('publicextract.charity.txt');
  const header = new Uint8Array(30);
  const v = new DataView(header.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);
  v.setUint16(6, 8, true); // data descriptor follows the data
  v.setUint16(8, 8, true);
  v.setUint16(26, name.length, true);
  const trailer = new Uint8Array(16 + 80);
  const tv = new DataView(trailer.buffer);
  tv.setUint32(0, 0x08074b50, true); // descriptor signature
  tv.setUint32(4, 0xdeadbeef, true); // crc32 (not checked)
  tv.setUint32(8, data.length, true); // compressed size — must equal the bytes before it
  tv.setUint32(12, new TextEncoder().encode(text).length, true); // uncompressed size
  trailer.fill(0x50, 16); // central-directory junk
  const out = new Uint8Array(30 + name.length + data.length + trailer.length);
  out.set(header, 0);
  out.set(name, 30);
  out.set(data, 30 + name.length);
  out.set(trailer, 30 + name.length + data.length);
  return out;
}

function chunked(bytes: Uint8Array, size = 1024): Response {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('inflateZipEntry', () => {
  it('tolerates the trailing data descriptor once the entry is fully inflated', async () => {
    const text = 'a\tb\n1\t2\n'.repeat(500);
    const zip = await dataDescriptorZip(text);
    const out = await new Response(inflateZipEntry(chunked(zip, 700).body!, 10_000_000)).text();
    expect(out).toBe(text);
  });

  it('still fails on a truncated entry', async () => {
    const zip = await dataDescriptorZip('a\tb\n1\t2\n'.repeat(500));
    const truncated = zip.subarray(0, Math.floor(zip.length / 2));
    await expect(
      new Response(inflateZipEntry(chunked(truncated).body!, 10_000_000)).text(),
    ).rejects.toThrow();
  });
});

describe('GET /v1/data/uk-charities', () => {
  it('unzips the tab-delimited extract, normalizes, and never serves contact details', async () => {
    const zip = await dataDescriptorZip(TSV);
    stubOrigins({ charities: () => chunked(zip) });
    await load();
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const banned of ['Volunteer Lane', 'Flat 3', '07700', 'secretary@', 'charity_contact']) {
      expect(text).not.toContain(banned);
    }
    const body = JSON.parse(text) as SuccessEnvelope<UkCharitiesRecord[]>;
    expect(body.data).toHaveLength(3); // nameless-org row and the Removed charity are skipped
    expect(body.data[0]).toEqual({
      organisation_number: 5001,
      registered_charity_number: 1100001,
      linked_charity_number: 0,
      name: 'ACME COMMUNITY TRUST',
      charity_type: 'CIO',
      registration_status: 'Registered',
      date_of_registration: '2015-03-02',
      date_of_removal: null,
      reporting_status: 'Submission Received',
      latest_financial_period_end: '2026-03-31',
      latest_income: 125000,
      latest_expenditure: 118000,
      postcode: 'LS1 4AB',
      outward_code: 'LS1',
      company_number: null,
      website: 'www.acme-trust.example',
      insolvent: false,
      in_administration: false,
      is_cio: true,
      cio_dissolved: false,
      gift_aid: true,
      has_land: false,
      activities: 'Runs a community centre and food bank in central Leeds.',
    });
    expect(body.data.find((r) => r.name === 'OLD HALL TRUST')).toBeUndefined();
    const hospice = body.data.find((r) => r.name === 'BIG HOSPICE LIMITED');
    expect(hospice?.activities).toHaveLength(240);
    expect(hospice?.in_administration).toBe(true);
    expect(hospice?.company_number).toBe('04123456');
  });

  it('filters by status, income, area, flags and dates', async () => {
    const zip = await dataDescriptorZip(TSV);
    stubOrigins({ charities: () => chunked(zip) });
    await load();
    const { key } = await issueKey();
    const names = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkCharitiesRecord[]
      >;
      return body.data.map((r) => r.name);
    };
    expect(await names('registration_status=Removed')).toEqual([]);
    expect(await names('latest_income_min=1000000')).toEqual(['BIG HOSPICE LIMITED']);
    expect(await names('outward_code=ls1')).toEqual(['ACME COMMUNITY TRUST']);
    expect(await names('in_administration=true')).toEqual(['BIG HOSPICE LIMITED']);
    expect(await names('is_cio=true')).toEqual(['ACME COMMUNITY TRUST']);
    expect(await names('website_present=true')).toEqual(['ACME COMMUNITY TRUST']);
    expect(await names('website_present=false')).not.toContain('ACME COMMUNITY TRUST');
    expect(await names('website_present=false')).toContain('BIG HOSPICE LIMITED');
    expect(
      await names('date_of_registration_after=2010-01-01&registration_status=Registered'),
    ).toEqual(['ACME COMMUNITY TRUST', 'ACME TRUST YOUTH WING']);
    expect(await names('registered_charity_number=1100001')).toEqual([
      'ACME COMMUNITY TRUST',
      'ACME TRUST YOUTH WING',
    ]);
  });

  it('falls back to bundled fixtures when the origin fails', async () => {
    stubOrigins({ charities: () => new Response('nope', { status: 503 }) });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<UkCharitiesRecord[]>;
    expect(body.meta?.total).toBe(30);
  });
});
