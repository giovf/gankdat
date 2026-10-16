import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/sam-exclusions.json';
import type { DataSource } from './types';
import { inflateZipEntry } from './zip';
import { originFetch } from './origin';

// US SAM.gov Exclusions (debarment) — every party excluded from US federal
// awards, from GSA's official daily PUBLIC extract (task 40; rebuilt 2026-09-20).
//
// Ingest reads the "Exclusions / Public V2" data-services extract: a daily ZIP
// (~12MB, one deflated CSV of ~78MB / ~168k rows) that SAM.gov publishes with
// NO account and NO API key — the file-extract listing + download endpoints are
// open. This replaced the key-gated Exclusions API v4 extract flow, whose
// non-federal no-role key tier (10 requests/day) could never complete the
// asynchronous extract poll in production (never one successful refresh
// 2026-07-13 → 2026-09-19). The ZIP is unwrapped and inflated as a stream
// (DecompressionStream 'deflate-raw'), then csvRows — the dataset is far past
// Worker memory, so this stays a storage:'d1' source with fetchStream.
//
// Data posture (terms reviewed 2026-07-12, logged on task 40): exclusion
// records are US-government works (public domain), BUT (a) the D&B Open Data
// fields (all addresses; legal-name provenance pre-2022) may not be
// disseminated in bulk — every address column is DROPPED at ingest (never
// read); (b) individual exclusions are personal data served for compliance
// purposes — same task-38 posture as uk-sanctions: no SSN/TIN/NPI, no
// addresses, no free-text comments, ever.

const LIST_URL =
  'https://sam.gov/api/prod/fileextractservices/v1/api/listfiles?domain=Exclusions/Public%20V2&privacy=Public';
const DOWNLOAD_BASE = 'https://sam.gov/api/prod/fileextractservices/v1/api/download/';
// The download endpoint answers 303 to a (signed) S3 object URL. Only these
// hosts are followed — one hop, https only.
const REDIRECT_HOSTS = /(^|\.)(sam\.gov|amazonaws\.com)$/;
const USER_AGENT = 'gankdat.com data refresh';

export const samExclusionsRecordSchema = z.object({
  /** Excluded party's name as designated (individuals: prefix/first/middle/last/suffix joined). */
  name: z.string(),
  /** Individual | Firm | Special Entity Designation | Vessel. */
  classification: z.string().nullable(),
  exclusion_type: z.string().nullable(),
  /** Reciprocal | Procurement | Nonprocurement. */
  exclusion_program: z.string().nullable(),
  excluding_agency: z.string().nullable(),
  /** Not present in the public extract (was API-only); kept null for schema stability. */
  excluding_agency_name: z.string().nullable(),
  uei_sam: z.string().nullable(),
  cage_code: z.string().nullable(),
  activation_date: z.string().nullable(),
  termination_date: z.string().nullable(),
  /** Definite (dated) | Indefinite. */
  termination_type: z.string().nullable(),
});

export type SamExclusionsRecord = z.infer<typeof samExclusionsRecordSchema>;

/** Extract cells use '' AND the literal string 'null' for absent values. */
function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' || trimmed.toLowerCase() === 'null' ? null : trimmed;
}

/** YYYY-MM-DD (public extract) or MM-DD-YYYY (legacy API extract) → YYYY-MM-DD; else null. */
function isoDate(raw: string | null): string | null {
  if (raw === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : null;
}

// Public-extract header names. Address, NPI, comment and cross-reference
// columns are deliberately absent from this list — they are never read.
const REQUIRED_COLUMNS = [
  'Classification',
  'Name',
  'First',
  'Last',
  'Exclusion Program',
  'Excluding Agency',
  'Exclusion Type',
  'Active Date',
  'Termination Date',
  'Record Status',
] as const;

function normalizeRow(cols: string[], idx: Map<string, number>): SamExclusionsRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  // The extract is documented as active-only; enforce it anyway.
  const status = col('Record Status');
  if (status !== null && status.toLowerCase() !== 'active') return null;
  const name =
    col('Name') ??
    [col('Prefix'), col('First'), col('Middle'), col('Last'), col('Suffix')]
      .filter((part): part is string => part !== null)
      .join(' ');
  if (!name) return null;
  const terminationRaw = col('Termination Date');
  const terminationDate = isoDate(terminationRaw);
  return {
    name,
    classification: col('Classification'),
    exclusion_type: col('Exclusion Type'),
    exclusion_program: col('Exclusion Program'),
    excluding_agency: col('Excluding Agency'),
    excluding_agency_name: null,
    uei_sam: col('Unique Entity ID'),
    cage_code: col('CAGE'),
    activation_date: isoDate(col('Active Date')),
    termination_date: terminationDate,
    termination_type:
      terminationDate !== null
        ? 'Definite'
        : terminationRaw !== null && /indefinite/i.test(terminationRaw)
          ? 'Indefinite'
          : null,
  };
}

// Abort decompression if the extract expands past this — the real dataset is
// ~78MB; this bounds a zip-bomb from a compromised origin.
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

/** ZIP body → inflated CSV bytes, byte-capped (shared unwrapper in zip.ts). */
function csvStreamFromZip(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return inflateZipEntry(body, MAX_DECOMPRESSED_BYTES);
}

interface ExtractListing {
  _embedded?: { customS3ObjectSummaryList?: { displayKey?: string; key?: string }[] };
}

const EXTRACT_PREFIX = 'Exclusions/Public V2/SAM_Exclusions_Public_Extract_V2_';
// SAM's listing endpoint has transient "retry in a couple minutes" 500s; the
// download endpoint is separate and the file name is deterministic (YY + day
// of year), so the listing is best-effort with a computed fallback.
const LIST_ATTEMPTS = 3;
const LIST_RETRY_DELAY_MS = 15_000;
const FALLBACK_DAYS = 4;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Newest "…_V2_<yyddd>.ZIP" object key from the public listing, or null if the listing is down. */
async function listedExtractKey(): Promise<string | null> {
  for (let attempt = 1; attempt <= LIST_ATTEMPTS; attempt += 1) {
    try {
      const res = await originFetch(LIST_URL, { headers: { 'user-agent': USER_AGENT } });
      if (res.ok) {
        const body = (await res.json()) as ExtractListing;
        let best: { serial: number; key: string } | null = null;
        for (const entry of body._embedded?.customS3ObjectSummaryList ?? []) {
          const match = /SAM_Exclusions_Public_Extract_V2_(\d+)\.ZIP$/i.exec(
            entry.displayKey ?? '',
          );
          if (!match || !entry.key) continue;
          const serial = Number(match[1]);
          if (best === null || serial > best.serial) best = { serial, key: entry.key };
        }
        if (best !== null) return best.key;
      }
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'sam_listing_unavailable',
          attempt,
          status: res.status,
        }),
      );
    } catch (err) {
      // Network-level failure (DNS, TLS, no route): not the transient 500 the
      // retries exist for — go straight to the computed-key fallback.
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'sam_listing_unavailable',
          attempt,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      return null;
    }
    if (attempt < LIST_ATTEMPTS) await sleep(LIST_RETRY_DELAY_MS);
  }
  return null;
}

/** Object keys for today and the previous days (UTC), newest first: SAM names files YY + day-of-year. */
export function computedExtractKeys(
  now: Date = new Date(),
  days: number = FALLBACK_DAYS,
): string[] {
  const keys: string[] = [];
  for (let back = 0; back < days; back += 1) {
    const d = new Date(now.getTime() - back * 86_400_000);
    const dayOfYear = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
    const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
    keys.push(`${EXTRACT_PREFIX}${yy}${String(dayOfYear).padStart(3, '0')}.ZIP`);
  }
  return keys;
}

/**
 * Fetches an extract ZIP, following the single S3 redirect the endpoint issues.
 * Returns null when that day's file is not published (SAM answers 204/404).
 */
async function openExtract(key: string): Promise<Response | null> {
  const url = `${DOWNLOAD_BASE}${key.split('/').map(encodeURIComponent).join('/')}?privacy=Public`;
  const first = await originFetch(url, {
    headers: { 'user-agent': USER_AGENT },
    redirect: 'manual',
  });
  if (first.status === 204 || first.status === 404) return null;
  if (first.status >= 300 && first.status < 400) {
    const location = first.headers.get('location') ?? '';
    let target: URL;
    try {
      target = new URL(location, url);
    } catch {
      throw new Error('SAM extract download redirect had no usable location');
    }
    if (target.protocol !== 'https:' || !REDIRECT_HOSTS.test(target.hostname)) {
      throw new Error(`SAM extract download redirected off-origin (${target.hostname})`);
    }
    const second = await originFetch(target, {
      headers: { 'user-agent': USER_AGENT },
      redirect: 'manual',
    });
    if (second.status === 404) return null;
    if (!second.ok || !second.body) {
      throw new Error(`SAM extract download failed: ${second.status}`);
    }
    return second;
  }
  if (!first.ok || !first.body) throw new Error(`SAM extract download failed: ${first.status}`);
  return first;
}

async function* streamFromOrigin(): AsyncGenerator<SamExclusionsRecord> {
  const listed = await listedExtractKey();
  const candidates = listed !== null ? [listed] : computedExtractKeys();
  let res: Response | null = null;
  for (const key of candidates) {
    res = await openExtract(key);
    if (res !== null) break;
  }
  if (res === null) throw new Error('SAM extract: no published file among candidate days');
  let idx: Map<string, number> | null = null;
  let yielded = 0;
  for await (const row of csvRows(csvStreamFromZip(res.body!))) {
    if (idx === null) {
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(`SAM extract format changed — missing: ${missing.join(', ')}`);
      }
      continue;
    }
    const record = normalizeRow(row, idx);
    if (record) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('SAM extract parsed 0 records');
}

function fixtures(): SamExclusionsRecord[] {
  return z.array(samExclusionsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<SamExclusionsRecord> {
  let yielded = 0;
  try {
    for await (const record of streamFromOrigin()) {
      yielded += 1;
      yield record;
    }
  } catch (err) {
    // Only fall back if the stream failed BEFORE yielding anything. A mid-stream
    // failure has already fed partial real rows to the D1 loader; appending
    // fixtures would build a real/fixture hybrid generation.
    if (yielded === 0 && String(env.FIXTURE_FALLBACK) === 'true') {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'fixture_fallback',
          source: 'sam-exclusions',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const samExclusionsSource: DataSource<SamExclusionsRecord> = {
  slug: 'sam-exclusions',
  title: 'US federal exclusions (SAM.gov)',
  description:
    'Every active exclusion (debarment) on the official US SAM.gov list — individuals, firms, special entities, and vessels barred from federal awards, with agency, program, and dates — normalized for supplier due diligence. Served as published by the US government for compliance purposes; all addresses, identifiers (SSN/TIN/NPI), and free-text comments are dropped at ingest.',
  storage: 'd1',
  stats: {
    date: { field: 'activation_date', title: 'Exclusion actions by month' },
    groupBy: [
      { field: 'classification', title: 'By classification' },
      { field: 'excluding_agency', title: 'Most active excluding agencies' },
      { field: 'exclusion_program', title: 'By exclusion program' },
    ],
  },
  recordSchema: samExclusionsRecordSchema,
  queryParams: z.object({
    name: z.string().optional(),
    classification: z.string().optional(),
    exclusion_type: z.string().optional(),
    exclusion_program: z.string().optional(),
    excluding_agency: z.string().optional(),
    excluding_agency_name: z.string().optional(),
    uei_sam: z.string().optional(),
    cage_code: z.string().optional(),
    activation_date_after: z.iso.date().optional(),
    activation_date_before: z.iso.date().optional(),
    termination_date_after: z.iso.date().optional(),
    termination_date_before: z.iso.date().optional(),
  }),
  refresh: { cron: '15 5 * * *', cacheTtlSeconds: 86_400 },
  // No published id: name × classification × agency × activation date identifies an exclusion.
  idOf: (r) =>
    [r.name, r.classification ?? '', r.excluding_agency ?? '', r.activation_date ?? '']
      .join('|')
      .toLowerCase(),
  fetchStream,
  // Materializing path for callers that need an array (dev tooling); the D1
  // refresh always prefers fetchStream above.
  async fetchFresh(env: CloudflareBindings): Promise<SamExclusionsRecord[]> {
    const records: SamExclusionsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
