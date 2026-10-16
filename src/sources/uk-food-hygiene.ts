import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/uk-food-hygiene.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// UK Food Hygiene Rating Scheme (FHRS) — every rated food business in
// England, Wales and Northern Ireland (plus Scotland's FHIS pass/improvement
// scheme), from the Food Standards Agency's official open-data file (task 47).
//
// Ingest: the single all-UK CSV the FSA republishes daily
// (~145MB, ~610k establishments, OGL v3, no key, no registration). Streamed
// through csvRows into D1 (storage:'d1' + fetchStream) — far past Worker
// memory as a snapshot. Stable identifier: FHRSID.
//
// Data posture (NICHE-RESEARCH-2026-09 §3): business-level data only. The FSA
// already withholds the address and geocode of businesses trading from a
// private address, so what we ingest is trading names and trading addresses.
// The free-text "RightToReply" column (the operator's own comment) is DROPPED
// at ingest — it is the only field that can carry incidental personal detail.
// Rating *imagery* (the sticker artwork) is not OGL and is never served.

const ORIGIN_URL = 'https://ratings.food.gov.uk/api/open-data-files/FHRS_All_en-GB.csv';
const USER_AGENT = 'gankdat.com data refresh';
// The file is ~145MB today; a 5× ceiling bounds a runaway origin without
// tripping on organic growth.
const MAX_BYTES = 768 * 1024 * 1024;

export const ukFoodHygieneRecordSchema = z.object({
  /** FSA's stable establishment id. */
  fhrs_id: z.number().int(),
  business_name: z.string(),
  /** e.g. Restaurant/Cafe/Canteen, Takeaway/sandwich shop, Retailers - supermarkets/hypermarkets. */
  business_type: z.string().nullable(),
  /** Trading address, lines joined with ", " (private addresses are withheld by the FSA). */
  address: z.string().nullable(),
  postcode: z.string().nullable(),
  /** Outward code of the postcode, e.g. "CB2" — for area filtering. */
  outward_code: z.string().nullable(),
  local_authority: z.string().nullable(),
  local_authority_code: z.string().nullable(),
  /** "0".."5" (FHRS), "Pass" / "Improvement Required" (FHIS), "AwaitingInspection", "Exempt", "AwaitingPublication". */
  rating_value: z.string(),
  /** FHRS or FHIS. */
  scheme_type: z.string().nullable(),
  /** Date of the inspection that produced the rating (YYYY-MM-DD); null when not yet rated. */
  rating_date: z.string().nullable(),
  /** FHRS sub-scores: lower is better (0 = fully compliant). Null for FHIS/unrated. */
  hygiene_score: z.number().int().nullable(),
  structural_score: z.number().int().nullable(),
  confidence_score: z.number().int().nullable(),
  /** True when a newer inspection result is awaiting publication. */
  new_rating_pending: z.boolean(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
});

export type UkFoodHygieneRecord = z.infer<typeof ukFoodHygieneRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function intOrNull(value: string | null): number | null {
  if (value === null || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}

function floatOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** YYYY-MM-DD (the open-data file) or a date-time prefix; else null. */
function isoDate(raw: string | null): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw ?? '');
  return match ? match[1]! : null;
}

/** UK postcode outward code: everything before the final 3 characters, after normalising spaces. */
function outwardCode(postcode: string | null): string | null {
  if (postcode === null) return null;
  const compact = postcode.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) return null;
  return compact.slice(0, -3);
}

const REQUIRED_COLUMNS = [
  'FHRSID',
  'BusinessName',
  'BusinessType',
  'RatingValue',
  'RatingDate',
  'LocalAuthorityName',
  'PostCode',
  'SchemeType',
  'NewRatingPending',
] as const;

function normalizeRow(cols: string[], idx: Map<string, number>): UkFoodHygieneRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  const id = intOrNull(col('FHRSID'));
  const name = col('BusinessName');
  const rating = col('RatingValue');
  if (id === null || name === null || rating === null) return null;
  const postcode = col('PostCode');
  const address = [
    col('AddressLine1'),
    col('AddressLine2'),
    col('AddressLine3'),
    col('AddressLine4'),
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  return {
    fhrs_id: id,
    business_name: name,
    business_type: col('BusinessType'),
    address: address === '' ? null : address,
    postcode,
    outward_code: outwardCode(postcode),
    local_authority: col('LocalAuthorityName'),
    local_authority_code: col('LocalAuthorityCode'),
    rating_value: rating,
    scheme_type: col('SchemeType'),
    rating_date: isoDate(col('RatingDate')),
    hygiene_score: intOrNull(col('Hygiene')),
    structural_score: intOrNull(col('Structural')),
    confidence_score: intOrNull(col('ConfidenceInManagement')),
    new_rating_pending: (col('NewRatingPending') ?? '').toLowerCase() === 'true',
    latitude: floatOrNull(col('Latitude')),
    longitude: floatOrNull(col('Longitude')),
  };
}

/** Caps the total bytes read from a stream, aborting past the limit. */
function byteCapTransform(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new Error(`FHRS file exceeded ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

async function* streamFromOrigin(): AsyncGenerator<UkFoodHygieneRecord> {
  const res = await originFetch(ORIGIN_URL, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`FHRS download failed: ${res.status}`);
  let idx: Map<string, number> | null = null;
  let yielded = 0;
  for await (const row of csvRows(res.body.pipeThrough(byteCapTransform(MAX_BYTES)))) {
    if (idx === null) {
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(`FHRS file format changed — missing: ${missing.join(', ')}`);
      }
      continue;
    }
    const record = normalizeRow(row, idx);
    if (record) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('FHRS file parsed 0 records');
}

function fixtures(): UkFoodHygieneRecord[] {
  return z.array(ukFoodHygieneRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkFoodHygieneRecord> {
  let yielded = 0;
  try {
    for await (const record of streamFromOrigin()) {
      yielded += 1;
      yield record;
    }
  } catch (err) {
    // Fall back only if nothing was yielded — a mid-stream failure has already
    // fed real rows to the D1 loader (see sam-exclusions for the rationale).
    if (yielded === 0 && String(env.FIXTURE_FALLBACK) === 'true') {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'fixture_fallback',
          source: 'uk-food-hygiene',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukFoodHygieneSource: DataSource<UkFoodHygieneRecord> = {
  slug: 'uk-food-hygiene',
  title: 'UK food hygiene ratings (FSA)',
  description:
    'Every food business rated under the UK Food Hygiene Rating Scheme (England, Wales, Northern Ireland; Scotland FHIS) from the official Food Standards Agency open-data file — business name, type, trading address and area, local authority, rating value and date, hygiene/structural/confidence sub-scores, new-rating-pending flag and coordinates, keyed by the stable FHRSID. Refreshed daily. Operator comments are dropped at ingest; rating artwork is not served.',
  storage: 'd1',
  stats: {
    date: { field: 'rating_date', title: 'Inspections published by month' },
    groupBy: [
      { field: 'rating_value', title: 'By rating', limit: 10 },
      { field: 'business_type', title: 'By business type', limit: 15 },
      { field: 'local_authority', title: 'Largest local authorities', limit: 15 },
    ],
  },
  recordSchema: ukFoodHygieneRecordSchema,
  queryParams: z.object({
    business_name: z.string().optional(),
    business_type: z.string().optional(),
    postcode: z.string().optional(),
    outward_code: z.string().optional(),
    local_authority: z.string().optional(),
    local_authority_code: z.string().optional(),
    rating_value: z.string().optional(),
    scheme_type: z.string().optional(),
    rating_date_after: z.iso.date().optional(),
    rating_date_before: z.iso.date().optional(),
    hygiene_score_min: z.coerce.number().optional(),
    hygiene_score_max: z.coerce.number().optional(),
    structural_score_min: z.coerce.number().optional(),
    structural_score_max: z.coerce.number().optional(),
    confidence_score_min: z.coerce.number().optional(),
    confidence_score_max: z.coerce.number().optional(),
    new_rating_pending: z.stringbool().optional(),
  }),
  // ~6 min alone (613k rows) — its own wave.
  refresh: { cron: '45 5 * * *', cacheTtlSeconds: 86_400, wave: 4 },
  idOf: (r) => String(r.fhrs_id),
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkFoodHygieneRecord[]> {
    const records: UkFoodHygieneRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
