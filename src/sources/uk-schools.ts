import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/uk-schools.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// Schools, colleges and nurseries in England — DfE "Get Information About
// Schools" (GIAS) all-establishment extract, enriched with Ofsted's monthly
// inspection-outcome management information (NICHE-RESEARCH-2026-09-B §1).
//
// Ingest: GIAS republishes the full establishment CSV every day under a dated
// URL (`edubasealldata<YYYYMMDD>.csv`) — no login, no key — so the refresh
// walks back from today until a day resolves, then streams it into D1.
// Ofsted's inspection outcomes are a separate monthly CSV on GOV.UK, resolved
// through the Content API the same way `uk-sponsors` resolves its register.
//
// The Ofsted join is BEST-EFFORT by design: GIAS carries its own
// `OfstedRating (name)` / `OfstedLastInsp` columns, so a school always has an
// Ofsted verdict from the daily file. The monthly Ofsted file only overrides
// it with a fresher outcome — if GOV.UK moves or renames it, the refresh logs
// and carries on with the GIAS values rather than failing the whole dataset.
//
// Data posture (Blind Mode): establishment-level only. The head-teacher name
// columns (HeadTitle / HeadFirstName / HeadLastName) and the telephone column
// are DROPPED at ingest, and GIAS's separate governors extract — which is
// entirely personal data — is never fetched.

const GIAS_FILE_BASE =
  'https://ea-edubase-api-prod.azurewebsites.net/edubase/downloads/public/edubasealldata';
const GIAS_HOST = /(^|\.)ea-edubase-api-prod\.azurewebsites\.net$/;
const OFSTED_CONTENT_API_URL =
  'https://www.gov.uk/api/content/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes';
const ASSET_HOST = /(^|\.)(publishing\.service\.gov\.uk|gov\.uk)$/;
const USER_AGENT = 'gankdat.com data refresh';
const MAX_BYTES = 256 * 1024 * 1024;
const OFSTED_MAX_BYTES = 64 * 1024 * 1024;
/** How many days back to look for a published GIAS extract before giving up. */
const GIAS_LOOKBACK_DAYS = 8;

export const ukSchoolsRecordSchema = z.object({
  /** DfE Unique Reference Number — stable across renames and re-openings. */
  urn: z.string(),
  name: z.string(),
  /** e.g. "Academy converter", "Community school", "Further education", "Other independent school". */
  establishment_type: z.string().nullable(),
  /** e.g. "Primary", "Secondary", "16 plus", "Nursery", "All-through". */
  phase: z.string().nullable(),
  /** "Open", "Closed", "Proposed to open", "Open, but proposed to close". */
  status: z.string().nullable(),
  local_authority: z.string().nullable(),
  /** Government Office Region, e.g. "London", "North West". */
  region: z.string().nullable(),
  address: z.string().nullable(),
  town: z.string().nullable(),
  postcode: z.string().nullable(),
  outward_code: z.string().nullable(),
  website: z.string().nullable(),
  /** Places the establishment is funded for (null when GIAS has none). */
  school_capacity: z.number().nullable(),
  /** Pupils on roll at the last census. */
  pupils: z.number().nullable(),
  statutory_low_age: z.number().nullable(),
  statutory_high_age: z.number().nullable(),
  /** Multi-academy or single-academy trust, when the school belongs to one. */
  trust_name: z.string().nullable(),
  trust_id: z.string().nullable(),
  open_date: z.string().nullable(),
  close_date: z.string().nullable(),
  /** "Outstanding", "Good", "Requires improvement", "Serious Weaknesses", … */
  ofsted_rating: z.string().nullable(),
  /** Date of the latest inspection the outcome comes from (YYYY-MM-DD). */
  ofsted_last_inspection: z.string().nullable(),
  gias_url: z.string(),
});

export type UkSchoolsRecord = z.infer<typeof ukSchoolsRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/** "01-09-2014", "01/09/2014" (GIAS) or "2014-09-01" → "2014-09-01"; else null. */
function isoDate(raw: string | null): string | null {
  if (raw === null) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/.exec(raw);
  if (!dmy) return null;
  return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
}

function number(raw: string | null): number | null {
  if (raw === null) return null;
  const parsed = Number(raw.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function outwardCode(postcode: string | null): string | null {
  if (postcode === null) return null;
  const compact = postcode.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) return null;
  return compact.slice(0, -3);
}

// GIAS suffixes many columns with " (name)" / " (code)". Each logical field
// lists its accepted headers so a suffix tweak upstream degrades one field
// instead of failing the load; REQUIRED_COLUMNS below is what must exist.
const COL = {
  urn: ['URN'],
  name: ['EstablishmentName'],
  type: ['TypeOfEstablishment (name)', 'TypeOfEstablishment'],
  phase: ['PhaseOfEducation (name)', 'PhaseOfEducation'],
  status: ['EstablishmentStatus (name)', 'EstablishmentStatus'],
  la: ['LA (name)', 'LA'],
  region: ['GOR (name)', 'GOR'],
  street: ['Street'],
  locality: ['Locality'],
  address3: ['Address3'],
  town: ['Town'],
  postcode: ['Postcode'],
  website: ['SchoolWebsite'],
  capacity: ['SchoolCapacity'],
  pupils: ['NumberOfPupils'],
  lowAge: ['StatutoryLowAge'],
  highAge: ['StatutoryHighAge'],
  trustName: ['Trusts (name)', 'Trusts'],
  trustId: ['Trusts (code)'],
  openDate: ['OpenDate'],
  closeDate: ['CloseDate'],
  ofstedRating: ['OfstedRating (name)', 'OfstedRating'],
  ofstedLastInsp: ['OfstedLastInsp'],
} as const;

const REQUIRED_COLUMNS = ['URN', 'EstablishmentName'] as const;

function reader(
  idx: Map<string, number>,
  cols: string[],
): (names: readonly string[]) => string | null {
  return (names) => {
    for (const name of names) {
      const at = idx.get(name);
      if (at !== undefined) {
        const value = clean(cols[at]);
        if (value !== null) return value;
      }
    }
    return null;
  };
}

function headerIndex(row: string[]): Map<string, number> {
  return new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
}

function normalizeRow(cols: string[], idx: Map<string, number>): UkSchoolsRecord | null {
  const col = reader(idx, cols);
  const urn = col(COL.urn);
  const name = col(COL.name);
  if (urn === null || name === null || !/^\d+$/.test(urn)) return null;
  const postcode = col(COL.postcode);
  const address = [col(COL.street), col(COL.locality), col(COL.address3)]
    .filter((part): part is string => part !== null)
    .join(', ');
  return {
    urn,
    name,
    establishment_type: col(COL.type),
    phase: col(COL.phase),
    status: col(COL.status),
    local_authority: col(COL.la),
    region: col(COL.region),
    address: address === '' ? null : address,
    town: col(COL.town),
    postcode,
    outward_code: outwardCode(postcode),
    website: col(COL.website),
    school_capacity: number(col(COL.capacity)),
    pupils: number(col(COL.pupils)),
    statutory_low_age: number(col(COL.lowAge)),
    statutory_high_age: number(col(COL.highAge)),
    trust_name: col(COL.trustName),
    trust_id: col(COL.trustId),
    open_date: isoDate(col(COL.openDate)),
    close_date: isoDate(col(COL.closeDate)),
    ofsted_rating: col(COL.ofstedRating),
    ofsted_last_inspection: isoDate(col(COL.ofstedLastInsp)),
    gias_url: `https://get-information-schools.service.gov.uk/Establishments/Establishment/Details/${urn}`,
  };
}

/** Caps the total bytes read from a stream, aborting past the limit. */
function byteCapTransform(limit: number, what: string): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new Error(`${what} exceeded ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

function stamp(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
}

/**
 * The GIAS extract for the most recent day that resolves. The file is
 * published daily under a dated path, and the day it lands varies with DfE's
 * own run, so walk back a few days before treating it as an outage.
 */
async function giasResponse(): Promise<Response> {
  const today = Date.now();
  let lastStatus = 0;
  for (let back = 0; back < GIAS_LOOKBACK_DAYS; back += 1) {
    const day = stamp(new Date(today - back * 86_400_000));
    const url = new URL(`${GIAS_FILE_BASE}${day}.csv`);
    if (url.protocol !== 'https:' || !GIAS_HOST.test(url.hostname)) {
      throw new Error(`GIAS extract on unexpected host (${url.hostname})`);
    }
    const res = await originFetch(url.toString(), { headers: { 'user-agent': USER_AGENT } });
    if (res.ok && res.body) return res;
    lastStatus = res.status;
  }
  throw new Error(
    `GIAS extract not published in the last ${GIAS_LOOKBACK_DAYS} days (${lastStatus})`,
  );
}

interface ContentApiResponse {
  details?: { attachments?: { url?: string; content_type?: string; title?: string }[] };
}

/** Ofsted's "most recent inspections" CSV attachment, via the GOV.UK Content API. */
async function ofstedCsvUrl(): Promise<string> {
  const res = await originFetch(OFSTED_CONTENT_API_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GOV.UK content API failed: ${res.status}`);
  const body = (await res.json()) as ContentApiResponse;
  const csvs = (body.details?.attachments ?? []).filter(
    (a) => (a.content_type ?? '').includes('csv') || /\.csv$/i.test(a.url ?? ''),
  );
  // Prefer the "most recent inspections" file over the year-to-date one.
  const attachment =
    csvs.find((a) => /most recent|latest/i.test(a.title ?? '')) ??
    csvs.find((a) => !/year.to.date|provider.level/i.test(a.title ?? '')) ??
    csvs[0];
  if (!attachment?.url) throw new Error('Ofsted publication has no CSV attachment');
  const url = new URL(attachment.url, 'https://www.gov.uk');
  if (url.protocol !== 'https:' || !ASSET_HOST.test(url.hostname)) {
    throw new Error(`Ofsted attachment on unexpected host (${url.hostname})`);
  }
  return url.toString();
}

const OFSTED_GRADES: Record<string, string> = {
  '1': 'Outstanding',
  '2': 'Good',
  '3': 'Requires improvement',
  '4': 'Inadequate',
};

const OFSTED_COL = {
  urn: ['URN'],
  rating: [
    'Overall effectiveness',
    'Overall effectiveness (1-4)',
    'Outcome of latest inspection',
    'Overall outcome',
  ],
  date: ['Inspection start date', 'Inspection date', 'Inspection Start Date', 'Publication date'],
} as const;

export interface OfstedOutcome {
  rating: string;
  date: string | null;
}

/**
 * URN → latest published Ofsted outcome. Small by construction (one short
 * grade + date per inspected school, ~30k schools), so it is held in memory
 * while the much larger GIAS file streams past.
 */
async function ofstedOutcomes(): Promise<Map<string, OfstedOutcome>> {
  const outcomes = new Map<string, OfstedOutcome>();
  const res = await originFetch(await ofstedCsvUrl(), { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`Ofsted outcomes download failed: ${res.status}`);
  let idx: Map<string, number> | null = null;
  for await (const row of csvRows(
    res.body.pipeThrough(byteCapTransform(OFSTED_MAX_BYTES, 'Ofsted outcomes')),
  )) {
    if (idx === null) {
      const candidate = headerIndex(row);
      // A few Ofsted releases carry title lines above the header row.
      if (!candidate.has('URN')) continue;
      idx = candidate;
      continue;
    }
    const col = reader(idx, row);
    const urn = col(OFSTED_COL.urn);
    const raw = col(OFSTED_COL.rating);
    if (urn === null || raw === null) continue;
    const rating = OFSTED_GRADES[raw] ?? raw;
    outcomes.set(urn, { rating, date: isoDate(col(OFSTED_COL.date)) });
  }
  if (idx === null) throw new Error('Ofsted outcomes header row not found');
  return outcomes;
}

/** The Ofsted outcome wins only when it is at least as recent as GIAS's own. */
function withOfsted(record: UkSchoolsRecord, outcome: OfstedOutcome | undefined): UkSchoolsRecord {
  if (!outcome) return record;
  const known = record.ofsted_last_inspection;
  if (known !== null && outcome.date !== null && outcome.date < known) return record;
  return {
    ...record,
    ofsted_rating: outcome.rating,
    ofsted_last_inspection: outcome.date ?? known,
  };
}

async function* streamFromOrigin(): AsyncGenerator<UkSchoolsRecord> {
  // Best-effort enrichment: a missing or moved Ofsted file must not cost us
  // the whole establishment register, which already carries an Ofsted column.
  let outcomes = new Map<string, OfstedOutcome>();
  try {
    outcomes = await ofstedOutcomes();
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'ofsted_enrichment_skipped',
        source: 'uk-schools',
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const res = await giasResponse();
  let idx: Map<string, number> | null = null;
  let yielded = 0;
  for await (const row of csvRows(
    res.body!.pipeThrough(byteCapTransform(MAX_BYTES, 'GIAS extract')),
  )) {
    if (idx === null) {
      idx = headerIndex(row);
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(`GIAS extract format changed — missing: ${missing.join(', ')}`);
      }
      continue;
    }
    const record = normalizeRow(row, idx);
    if (record) {
      yielded += 1;
      yield withOfsted(record, outcomes.get(record.urn));
    }
  }
  if (yielded === 0) throw new Error('GIAS extract parsed 0 records');
}

function fixtures(): UkSchoolsRecord[] {
  return z.array(ukSchoolsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkSchoolsRecord> {
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
          source: 'uk-schools',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukSchoolsSource: DataSource<UkSchoolsRecord> = {
  slug: 'uk-schools',
  title: 'Schools and colleges in England (GIAS + Ofsted)',
  description:
    'Every school, academy, college and nursery on the Department for Education register (Get Information About Schools) — URN, name, type and phase, open/closed status, local authority and region, address and postcode, website, capacity and pupils on roll, age range, and the academy trust — joined by URN to the latest published Ofsted inspection outcome and inspection date. From the official daily GIAS extract and Ofsted’s monthly inspection management information. Head-teacher names and telephone numbers are dropped at ingest; the governors extract is never ingested.',
  storage: 'd1',
  stats: {
    date: { field: 'ofsted_last_inspection', title: 'Latest Ofsted inspections by month' },
    groupBy: [
      { field: 'phase', title: 'By phase of education', limit: 10 },
      { field: 'establishment_type', title: 'By establishment type', limit: 12 },
      { field: 'ofsted_rating', title: 'By Ofsted rating', limit: 8 },
      { field: 'local_authority', title: 'Largest local authorities', limit: 15 },
    ],
  },
  recordSchema: ukSchoolsRecordSchema,
  queryParams: z.object({
    name: z.string().optional(),
    urn: z.string().optional(),
    establishment_type: z.string().optional(),
    phase: z.string().optional(),
    status: z.string().optional(),
    local_authority: z.string().optional(),
    region: z.string().optional(),
    town: z.string().optional(),
    postcode: z.string().optional(),
    outward_code: z.string().optional(),
    trust_name: z.string().optional(),
    ofsted_rating: z.string().optional(),
    pupils_min: z.coerce.number().optional(),
    pupils_max: z.coerce.number().optional(),
    /** true = has a website on the register; false = none listed (lead feed for web agencies). */
    website_present: z.stringbool().optional(),
    ofsted_last_inspection_after: z.iso.date().optional(),
    ofsted_last_inspection_before: z.iso.date().optional(),
    open_date_after: z.iso.date().optional(),
    open_date_before: z.iso.date().optional(),
  }),
  refresh: { cron: '50 5 * * *', cacheTtlSeconds: 86_400, wave: 5 },
  idOf: (r) => r.urn,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkSchoolsRecord[]> {
    const records: UkSchoolsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
