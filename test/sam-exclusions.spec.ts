import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { computedExtractKeys, samExclusionsSource } from '../src/sources/sam-exclusions';
import { zipFirstEntryDeflate } from '../src/sources/zip';
import type { SamExclusionsRecord } from '../src/sources/sam-exclusions';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const SAM_URL = 'https://example.com/v1/data/sam-exclusions';

// D1 sources load via refresh (cron in prod), NOT on query — so tests must
// populate the table before querying, mirroring the real contract.
function load(): Promise<unknown> {
  return refreshD1Source(env, samExclusionsSource);
}

// Public-extract column layout (subset, same header names). Address, NPI and
// comment columns are present so the tests can prove they never leak.
const CSV = [
  '"Classification","Name","Prefix","First","Middle","Last","Suffix","Address 1","City","Zip Code","Unique Entity ID","Exclusion Program","Excluding Agency","Exclusion Type","Additional Comments","Active Date","Termination Date","Record Status","CAGE","NPI"',
  '"Firm","ACME SANCTIONED LLC","","","","","","1 Secret St","Springfield","99999-0001","UEI123456789","Reciprocal","TREAS-OFAC","Prohibition/Restriction","do not serve this","2026-03-15","2027-03-15","Active","","null"',
  '"Individual","","Ms","Jane","Q","Debarred","","2 Hidden Ave","Shelbyville","54321","","Reciprocal","DOJ","Ineligible (Proceedings Complete)","","2025-01-05","Indefinite","Active","","1234567890"',
  '"Vessel","FISHING, VESSEL ONE","","","","","","","","","null","Reciprocal","OFAC","Prohibition/Restriction","","2026-06-01","2036-06-01","Active","",""',
  '"Firm","","","","","","","","","","","Procurement","EPA","Preliminarily Ineligible (Proceedings Pending)","","2026-02-02","Indefinite","Active","1ABC2",""',
  '"Firm","OLD INACTIVE CO","","","","","","","","","","Procurement","EPA","Ineligible","","2020-02-02","2021-02-02","Inactive","",""',
].join('\n');

const LISTING = (serials: number[]): Response =>
  Response.json({
    _embedded: {
      customS3ObjectSummaryList: serials.map((n) => ({
        displayKey: `SAM_Exclusions_Public_Extract_V2_${n}.ZIP`,
        dateModified: 'Sep 19,2026',
        key: `Exclusions/Public V2/SAM_Exclusions_Public_Extract_V2_${n}.ZIP`,
      })),
    },
  });

async function deflateRaw(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A real single-entry ZIP (local header + deflate data + trailing junk standing in for the central directory). */
async function zipOf(
  text: string,
  opts: { method?: number; trailing?: number } = {},
): Promise<Uint8Array> {
  const data = await deflateRaw(text);
  const name = new TextEncoder().encode('SAM_Exclusions_Public_Extract_V2_26262.CSV');
  const header = new Uint8Array(30);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, 0, true); // flags: sizes known up front
  view.setUint16(8, opts.method ?? 8, true);
  view.setUint32(18, data.length, true); // compressed size
  view.setUint32(22, text.length, true); // uncompressed size (informational)
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true);
  const trailing = new Uint8Array(opts.trailing ?? 64).fill(0x50); // "PK…" junk the inflater must never see
  const out = new Uint8Array(header.length + name.length + data.length + trailing.length);
  out.set(header, 0);
  out.set(name, header.length);
  out.set(data, header.length + name.length);
  out.set(trailing, header.length + name.length + data.length);
  return out;
}

function s3Redirect(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location:
        'https://falextracts.s3.amazonaws.com/Exclusions/Public%20V2/SAM_Exclusions_Public_Extract_V2_26262.ZIP?X-Amz-Signature=abc',
    },
  });
}

/** Serves bytes in small chunks so header parsing across chunk boundaries is exercised. */
function chunked(bytes: Uint8Array, size = 7): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/zip' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Listing retries sleep 15s apiece; make them instant. */
function instantTimers(): void {
  vi.stubGlobal('setTimeout', ((fn: () => void): number => {
    fn();
    return 0;
  }) as never);
}

describe('computedExtractKeys', () => {
  it('names files YY + day-of-year, newest first', () => {
    expect(computedExtractKeys(new Date('2026-09-19T12:00:00Z'), 2)).toEqual([
      'Exclusions/Public V2/SAM_Exclusions_Public_Extract_V2_26262.ZIP',
      'Exclusions/Public V2/SAM_Exclusions_Public_Extract_V2_26261.ZIP',
    ]);
    expect(computedExtractKeys(new Date('2027-01-01T00:00:00Z'), 2)).toEqual([
      'Exclusions/Public V2/SAM_Exclusions_Public_Extract_V2_27001.ZIP',
      'Exclusions/Public V2/SAM_Exclusions_Public_Extract_V2_26365.ZIP',
    ]);
  });
});

describe('zipFirstEntryDeflate', () => {
  it('forwards exactly the compressed bytes of the first entry and drops trailing data', async () => {
    const text = 'a,b\n1,2\n';
    const zip = await zipOf(text, { trailing: 500 });
    const inflated = await new Response(
      chunked(zip, 5)
        .body!.pipeThrough(zipFirstEntryDeflate())
        .pipeThrough(new DecompressionStream('deflate-raw')),
    ).text();
    expect(inflated).toBe(text);
  });

  it('rejects non-ZIP and non-deflate input', async () => {
    await expect(
      new Response(
        new Blob(['not a zip at all, definitely not, nowhere near one'])
          .stream()
          .pipeThrough(zipFirstEntryDeflate()),
      ).text(),
    ).rejects.toThrow(/not a ZIP/);
    const stored = await zipOf('x', { method: 0 });
    await expect(
      new Response(new Blob([stored]).stream().pipeThrough(zipFirstEntryDeflate())).text(),
    ).rejects.toThrow(/unsupported method/);
  });
});

describe('GET /v1/data/sam-exclusions', () => {
  it('lists, follows the S3 redirect, unzips, normalizes, and never serves dropped fields', async () => {
    const zip = await zipOf(CSV);
    stubOrigins({
      samList: () => LISTING([26261, 26262]),
      samDownload: s3Redirect,
      samFile: () => chunked(zip, 1024),
    });
    await load();
    const res = await authedFetch(SAM_URL);
    expect(res.status).toBe(200);
    const text = await res.text();
    // D&B / personal-data strip: address, identifier, and comment fields must
    // never appear in any response, in any casing.
    for (const banned of [
      'secret st',
      'hidden ave',
      'springfield',
      '99999',
      '1234567890',
      'do not serve',
    ]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
    const body = JSON.parse(text) as SuccessEnvelope<SamExclusionsRecord[]>;
    // Nameless row and inactive row are skipped.
    expect(body.data).toHaveLength(3);
    expect(body.data[0]).toEqual({
      name: 'ACME SANCTIONED LLC',
      classification: 'Firm',
      exclusion_type: 'Prohibition/Restriction',
      exclusion_program: 'Reciprocal',
      excluding_agency: 'TREAS-OFAC',
      excluding_agency_name: null,
      uei_sam: 'UEI123456789',
      cage_code: null,
      activation_date: '2026-03-15',
      termination_date: '2027-03-15',
      termination_type: 'Definite',
    });
    const jane = body.data.find((r) => r.classification === 'Individual');
    expect(jane?.name).toBe('Ms Jane Q Debarred');
    expect(jane?.termination_date).toBeNull();
    expect(jane?.termination_type).toBe('Indefinite');
    const vessel = body.data.find((r) => r.classification === 'Vessel');
    expect(vessel?.name).toBe('FISHING, VESSEL ONE');
    expect(vessel?.uei_sam).toBeNull();
  });

  it('downloads the newest extract in the listing', async () => {
    const zip = await zipOf(CSV);
    const mock = stubOrigins({
      samList: () => LISTING([26100, 26262, 26007]),
      samDownload: s3Redirect,
      samFile: () => chunked(zip),
    });
    await load();
    const downloadCall = mock.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/api/download/'));
    expect(downloadCall).toContain('SAM_Exclusions_Public_Extract_V2_26262.ZIP');
    expect(downloadCall).toContain('Public%20V2');
  });

  it('falls back to computed file names when the listing is down, skipping unpublished days', async () => {
    instantTimers();
    const zip = await zipOf(CSV);
    let downloads = 0;
    const mock = stubOrigins({
      samList: () => new Response('{"errorMessage":"retry"}', { status: 500 }),
      samDownload: () => {
        downloads += 1;
        // Today's file is not published yet (SAM answers 204); yesterday's is.
        return downloads === 1 ? new Response(null, { status: 204 }) : s3Redirect();
      },
      samFile: () => chunked(zip),
    });
    await load();
    const urls = mock.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((u) => u.includes('/api/listfiles')).length).toBe(3);
    const expected = computedExtractKeys(new Date(), 2).map((k) => k.split('/').pop());
    const downloaded = urls.filter((u) => u.includes('/api/download/'));
    expect(downloaded[0]).toContain(expected[0]);
    expect(downloaded[1]).toContain(expected[1]);
    const res = await authedFetch(SAM_URL);
    const body = (await res.json()) as SuccessEnvelope<SamExclusionsRecord[]>;
    expect(body.meta?.total).toBe(3);
  });

  it('refuses a redirect to an unexpected host and falls back to fixtures', async () => {
    stubOrigins({
      samList: () => LISTING([26262]),
      samDownload: () =>
        new Response(null, { status: 303, headers: { location: 'https://evil.example/x.zip' } }),
    });
    await load();
    const res = await authedFetch(SAM_URL);
    const body = (await res.json()) as SuccessEnvelope<SamExclusionsRecord[]>;
    expect(body.meta?.total).toBe(28);
  });

  it('filters by name substring, classification, and activation date', async () => {
    const zip = await zipOf(CSV);
    stubOrigins({
      samList: () => LISTING([26262]),
      samDownload: s3Redirect,
      samFile: () => chunked(zip),
    });
    await load();
    const { key } = await issueKey();

    const byName = (await (
      await authedFetch(`${SAM_URL}?name=acme`, key)
    ).json()) as SuccessEnvelope<SamExclusionsRecord[]>;
    expect(byName.data.map((r) => r.name)).toEqual(['ACME SANCTIONED LLC']);

    const individuals = (await (
      await authedFetch(`${SAM_URL}?classification=Individual`, key)
    ).json()) as SuccessEnvelope<SamExclusionsRecord[]>;
    expect(individuals.data.map((r) => r.name)).toEqual(['Ms Jane Q Debarred']);

    const recent = (await (
      await authedFetch(`${SAM_URL}?activation_date_after=2026-01-01`, key)
    ).json()) as SuccessEnvelope<SamExclusionsRecord[]>;
    expect(recent.data.map((r) => r.name)).toEqual(['ACME SANCTIONED LLC', 'FISHING, VESSEL ONE']);
  });

  it('falls back to bundled fixtures when neither the listing nor any candidate file works', async () => {
    instantTimers();
    stubOrigins({
      samList: () => new Response('nope', { status: 500 }),
      samDownload: () => new Response(null, { status: 204 }),
    });
    await load();
    const res = await authedFetch(SAM_URL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<SamExclusionsRecord[]>;
    expect(body.meta?.total).toBe(28);
  });

  it('rejects malformed date params with a 400 envelope', async () => {
    const res = await authedFetch(`${SAM_URL}?activation_date_after=recently`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('bad_request');
  });
});
