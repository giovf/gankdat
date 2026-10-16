import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/uk-care-locations.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// CQC care directory — every health and social care location regulated by the
// Care Quality Commission in England (hospitals, care homes, GP practices,
// dentists, homecare agencies, hospices, ambulances), from CQC's weekly
// open-data CSV (task 50). OGL v3 with attribution; no key, no account.
//
// Ingest: the CSV lives under a dated URL that changes weekly, linked from
// CQC's "Using CQC data" page; the refresh reads that page for the current
// `…CQC_directory.csv` link, then streams the file (a few preamble lines
// precede the real header row) into D1. Stable id: CQC location id.
//
// Data posture: business/location-level only. The public phone number column
// is DROPPED at ingest; registered-manager names live in a different (monthly)
// file that is never ingested.

const INDEX_URL = 'https://www.cqc.org.uk/about-us/transparency/using-cqc-data';
const FILE_HOST = /(^|\.)cqc\.org\.uk$/;
const USER_AGENT = 'gankdat.com data refresh';
const MAX_BYTES = 256 * 1024 * 1024;

export const ukCareLocationsRecordSchema = z.object({
  /** CQC location id, e.g. "1-10552899555" (stable). */
  location_id: z.string(),
  provider_id: z.string().nullable(),
  name: z.string(),
  also_known_as: z.string().nullable(),
  address: z.string().nullable(),
  postcode: z.string().nullable(),
  outward_code: z.string().nullable(),
  website: z.string().nullable(),
  /** Service types as published, "|"-separated when several (e.g. "Care home|Nursing home"). */
  service_types: z.string().nullable(),
  /** Date of CQC's latest check/inspection (YYYY-MM-DD). */
  latest_check_date: z.string().nullable(),
  /** Specialisms / service-user bands, "|"-separated. */
  specialisms: z.string().nullable(),
  provider_name: z.string().nullable(),
  local_authority: z.string().nullable(),
  region: z.string().nullable(),
  cqc_url: z.string().nullable(),
});

export type UkCareLocationsRecord = z.infer<typeof ukCareLocationsRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/** "09/Jan/2018 - 00:00" → "2018-01-09"; also accepts YYYY-MM-DD; else null. */
function isoDate(raw: string | null): string | null {
  if (raw === null) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (iso) return iso[1]!;
  const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})/.exec(raw);
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  return month ? `${m[3]}-${month}-${m[1]!.padStart(2, '0')}` : null;
}

function outwardCode(postcode: string | null): string | null {
  if (postcode === null) return null;
  const compact = postcode.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) return null;
  return compact.slice(0, -3);
}

const COL = {
  name: 'Name',
  aka: 'Also known as',
  address: 'Address',
  postcode: 'Postcode',
  website: "Service's website (if available)",
  serviceTypes: 'Service types',
  latestCheck: 'Date of latest check',
  specialisms: 'Specialisms/services',
  provider: 'Provider name',
  localAuthority: 'Local authority',
  region: 'Region',
  url: 'Location URL',
  locationId: 'CQC Location ID (for office use only)',
  providerId: 'CQC Provider ID (for office use only)',
} as const;

const REQUIRED_COLUMNS = [COL.name, COL.serviceTypes, COL.locationId, COL.region] as const;

function normalizeRow(cols: string[], idx: Map<string, number>): UkCareLocationsRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  const id = col(COL.locationId);
  const name = col(COL.name);
  if (id === null || name === null) return null;
  const postcode = col(COL.postcode);
  return {
    location_id: id,
    provider_id: col(COL.providerId),
    name,
    also_known_as: col(COL.aka),
    address: col(COL.address)?.replace(/,(?=\S)/g, ', ') ?? null,
    postcode,
    outward_code: outwardCode(postcode),
    website: col(COL.website),
    service_types: col(COL.serviceTypes),
    latest_check_date: isoDate(col(COL.latestCheck)),
    specialisms: col(COL.specialisms),
    provider_name: col(COL.provider),
    local_authority: col(COL.localAuthority),
    region: col(COL.region),
    cqc_url: col(COL.url),
  };
}

/** Current weekly CSV URL from CQC's open-data page (the path is dated). */
async function currentCsvUrl(): Promise<string> {
  const res = await originFetch(INDEX_URL, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok) throw new Error(`CQC data page failed: ${res.status}`);
  const html = await res.text();
  const match = /href="([^"]*CQC_directory\.csv)"/i.exec(html);
  if (!match) throw new Error('CQC data page has no care-directory CSV link');
  const url = new URL(match[1]!, INDEX_URL);
  if (url.protocol !== 'https:' || !FILE_HOST.test(url.hostname)) {
    throw new Error(`CQC directory link on unexpected host (${url.hostname})`);
  }
  return url.toString();
}

/** Caps the total bytes read from a stream, aborting past the limit. */
function byteCapTransform(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new Error(`CQC directory exceeded ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

async function* streamFromOrigin(): AsyncGenerator<UkCareLocationsRecord> {
  const csvUrl = await currentCsvUrl();
  let res = await originFetch(csvUrl, { headers: { 'user-agent': USER_AGENT } });
  // CQC's file host answers 503 now and then (05:33 wave, 2026-09-21): retry before failing.
  for (let attempt = 1; res.status >= 500 && attempt <= 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, 30_000 * attempt));
    res = await originFetch(csvUrl, { headers: { 'user-agent': USER_AGENT } });
  }
  if (!res.ok || !res.body) throw new Error(`CQC directory download failed: ${res.status}`);
  let idx: Map<string, number> | null = null;
  let yielded = 0;
  let preamble = 0;
  for await (const row of csvRows(res.body.pipeThrough(byteCapTransform(MAX_BYTES)))) {
    if (idx === null) {
      // A few title/blank lines precede the header; the header starts with "Name".
      const first = (row[0] ?? '').replace(/^\uFEFF/, '').trim();
      if (first !== COL.name) {
        preamble += 1;
        if (preamble > 20) throw new Error('CQC directory header row not found');
        continue;
      }
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(`CQC directory format changed — missing: ${missing.join(', ')}`);
      }
      continue;
    }
    const record = normalizeRow(row, idx);
    if (record) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('CQC directory parsed 0 records');
}

function fixtures(): UkCareLocationsRecord[] {
  return z.array(ukCareLocationsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkCareLocationsRecord> {
  let yielded = 0;
  try {
    for await (const record of streamFromOrigin()) {
      yielded += 1;
      yield record;
    }
  } catch (err) {
    if (yielded === 0 && String(env.FIXTURE_FALLBACK) === 'true') {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'fixture_fallback',
          source: 'uk-care-locations',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukCareLocationsSource: DataSource<UkCareLocationsRecord> = {
  slug: 'uk-care-locations',
  title: 'Regulated care locations in England (CQC)',
  description:
    'Every health and social care location regulated by the Care Quality Commission in England — hospitals, care homes, GP practices, dentists, homecare agencies, hospices, ambulance services — with service types, specialisms, provider, address and area, local authority, region, and the date of the latest CQC check. From the official weekly CQC care directory, keyed by the stable CQC location id. Phone numbers are dropped at ingest; registered-manager names are never ingested.',
  storage: 'd1',
  stats: {
    date: { field: 'latest_check_date', title: 'Latest checks by month' },
    groupBy: [
      { field: 'region', title: 'By region', limit: 10 },
      { field: 'service_types', title: 'By service type', limit: 12 },
      { field: 'local_authority', title: 'Largest local authorities', limit: 15 },
    ],
  },
  recordSchema: ukCareLocationsRecordSchema,
  queryParams: z.object({
    name: z.string().optional(),
    provider_name: z.string().optional(),
    provider_id: z.string().optional(),
    service_types: z.string().optional(),
    specialisms: z.string().optional(),
    local_authority: z.string().optional(),
    region: z.string().optional(),
    postcode: z.string().optional(),
    outward_code: z.string().optional(),
    latest_check_date_after: z.iso.date().optional(),
    latest_check_date_before: z.iso.date().optional(),
    /** true = has a website on the register; false = none listed (lead feed for web agencies). */
    website_present: z.stringbool().optional(),
  }),
  refresh: { cron: '30 5 * * *', cacheTtlSeconds: 86_400, wave: 3 },
  idOf: (r) => r.location_id,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkCareLocationsRecord[]> {
    const records: UkCareLocationsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
