import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/uk-charities.json';
import type { DataSource } from './types';
import { inflateZipEntry } from './zip';
import { originFetch } from './origin';

// Register of charities in England & Wales — every currently registered
// charity, from the Charity Commission's daily public extract (task 49).
//
// Ingest: `publicextract.charity.zip` on the Commission's public blob storage
// (no account, no key; ~44MB zip → ~160MB tab-delimited text, ~400k rows of which
// ~185k are registered charities and ingested,
// refreshed daily ~01:10 UTC; OGL v3). Streamed through the shared ZIP
// unwrapper (data-descriptor ZIP — see zip.ts) into D1. Stable id:
// organisation_number (registered charities may have linked charities that
// share a registered number).
//
// Data posture (NICHE-RESEARCH-2026-09 §4): organisation-level only. Contact
// address lines, phone and email are DROPPED at ingest (they can be a
// volunteer's home details for small charities); postcode is kept for area
// filtering. Trustee names (a separate extract) are NOT ingested. The
// charity's own "activities" description is kept, capped in length.

const ORIGIN_URL =
  'https://ccewuksprdoneregsadata1.blob.core.windows.net/data/txt/publicextract.charity.zip';
const USER_AGENT = 'gankdat.com data refresh';
const MAX_BYTES = 768 * 1024 * 1024;
const ACTIVITIES_MAX_CHARS = 240;

export const ukCharitiesRecordSchema = z.object({
  /** Commission's stable id for the organisation (distinct per linked charity). */
  organisation_number: z.number().int(),
  registered_charity_number: z.number().int(),
  /** 0 for the main charity; >0 for a linked charity under the same registered number. */
  linked_charity_number: z.number().int(),
  name: z.string(),
  /** CIO, Charitable company, Trust, Previously excepted, Other; null when not stated. */
  charity_type: z.string().nullable(),
  /** Always "Registered" (removed charities are not ingested; removals appear in the change feed). */
  registration_status: z.string(),
  date_of_registration: z.string().nullable(),
  date_of_removal: z.string().nullable(),
  /** e.g. Submission Received, Submission Received Late, Submission Double Default, New, Removed. */
  reporting_status: z.string().nullable(),
  latest_financial_period_end: z.string().nullable(),
  latest_income: z.number().nullable(),
  latest_expenditure: z.number().nullable(),
  postcode: z.string().nullable(),
  outward_code: z.string().nullable(),
  company_number: z.string().nullable(),
  website: z.string().nullable(),
  insolvent: z.boolean().nullable(),
  in_administration: z.boolean().nullable(),
  is_cio: z.boolean().nullable(),
  cio_dissolved: z.boolean().nullable(),
  gift_aid: z.boolean().nullable(),
  has_land: z.boolean().nullable(),
  /** The charity's own description of its activities, capped at 240 characters. */
  activities: z.string().nullable(),
});

export type UkCharitiesRecord = z.infer<typeof ukCharitiesRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}
function intOrNull(v: string | null): number | null {
  return v !== null && /^-?\d+$/.test(v) ? Number(v) : null;
}
function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function boolOrNull(v: string | null): boolean | null {
  if (v === null) return null;
  const s = v.toLowerCase();
  return s === 'true' ? true : s === 'false' ? false : null;
}
/** "2014-04-16 00:00:00.0000000" → "2014-04-16". */
function isoDate(raw: string | null): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw ?? '');
  return m ? m[1]! : null;
}
function outwardCode(postcode: string | null): string | null {
  if (postcode === null) return null;
  const compact = postcode.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) return null;
  return compact.slice(0, -3);
}

const REQUIRED_COLUMNS = [
  'organisation_number',
  'registered_charity_number',
  'linked_charity_number',
  'charity_name',
  'charity_registration_status',
  'date_of_registration',
  'latest_income',
  'charity_contact_postcode',
] as const;

function normalizeRow(cols: string[], idx: Map<string, number>): UkCharitiesRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  const organisation = intOrNull(col('organisation_number'));
  const registered = intOrNull(col('registered_charity_number'));
  const name = col('charity_name');
  const status = col('charity_registration_status');
  if (organisation === null || registered === null || name === null || status === null) return null;
  // Only the live register: >200k historical "Removed" rows (some decades old) doubled the
  // load and blew the refresh budget. A charity that is removed from now on shows up in the
  // change feed as 'removed' with its last record.
  if (status.toLowerCase() !== 'registered') return null;
  const postcode = col('charity_contact_postcode');
  const activities = col('charity_activities');
  return {
    organisation_number: organisation,
    registered_charity_number: registered,
    linked_charity_number: intOrNull(col('linked_charity_number')) ?? 0,
    name,
    charity_type: col('charity_type'),
    registration_status: status,
    date_of_registration: isoDate(col('date_of_registration')),
    date_of_removal: isoDate(col('date_of_removal')),
    reporting_status: col('charity_reporting_status'),
    latest_financial_period_end: isoDate(col('latest_acc_fin_period_end_date')),
    latest_income: numOrNull(col('latest_income')),
    latest_expenditure: numOrNull(col('latest_expenditure')),
    postcode,
    outward_code: outwardCode(postcode),
    company_number: col('charity_company_registration_number'),
    website: col('charity_contact_web'),
    insolvent: boolOrNull(col('charity_insolvent')),
    in_administration: boolOrNull(col('charity_in_administration')),
    is_cio: boolOrNull(col('charity_is_cio')),
    cio_dissolved: boolOrNull(col('cio_is_dissolved')),
    gift_aid: boolOrNull(col('charity_gift_aid')),
    has_land: boolOrNull(col('charity_has_land')),
    activities: activities === null ? null : activities.slice(0, ACTIVITIES_MAX_CHARS),
  };
}

async function* streamFromOrigin(): AsyncGenerator<UkCharitiesRecord> {
  const res = await originFetch(ORIGIN_URL, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`charity extract download failed: ${res.status}`);
  let idx: Map<string, number> | null = null;
  let yielded = 0;
  for await (const row of csvRows(inflateZipEntry(res.body, MAX_BYTES), '\t')) {
    if (idx === null) {
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(`charity extract format changed — missing: ${missing.join(', ')}`);
      }
      continue;
    }
    const record = normalizeRow(row, idx);
    if (record) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('charity extract parsed 0 records');
}

function fixtures(): UkCharitiesRecord[] {
  return z.array(ukCharitiesRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkCharitiesRecord> {
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
          source: 'uk-charities',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukCharitiesSource: DataSource<UkCharitiesRecord> = {
  slug: 'uk-charities',
  title: 'Charities in England & Wales (Charity Commission)',
  description:
    "Every registered and removed charity on the Charity Commission register for England and Wales — name, charity and organisation numbers, type, registration status and dates, reporting status, latest income and expenditure, postcode area, company number, website, insolvency/administration/CIO flags, and the charity's own activities summary. From the official daily public extract; contact address lines, phone, email and trustee names are never ingested.",
  storage: 'd1',
  stats: {
    date: { field: 'date_of_registration', title: 'Registrations by month' },
    groupBy: [
      { field: 'registration_status', title: 'By registration status', limit: 4 },
      { field: 'charity_type', title: 'By charity type', limit: 8 },
      { field: 'reporting_status', title: 'By reporting status', limit: 8 },
      { field: 'outward_code', title: 'Largest postcode areas', limit: 15 },
    ],
  },
  recordSchema: ukCharitiesRecordSchema,
  queryParams: z.object({
    name: z.string().optional(),
    registered_charity_number: z.coerce.number().int().optional(),
    organisation_number: z.coerce.number().int().optional(),
    charity_type: z.string().optional(),
    registration_status: z.string().optional(),
    reporting_status: z.string().optional(),
    postcode: z.string().optional(),
    outward_code: z.string().optional(),
    company_number: z.string().optional(),
    date_of_registration_after: z.iso.date().optional(),
    date_of_registration_before: z.iso.date().optional(),
    date_of_removal_after: z.iso.date().optional(),
    date_of_removal_before: z.iso.date().optional(),
    latest_income_min: z.coerce.number().optional(),
    latest_income_max: z.coerce.number().optional(),
    insolvent: z.stringbool().optional(),
    in_administration: z.stringbool().optional(),
    is_cio: z.stringbool().optional(),
    gift_aid: z.stringbool().optional(),
    /** true = has a website on the register; false = none listed (lead feed for web agencies). */
    website_present: z.stringbool().optional(),
  }),
  refresh: { cron: '30 5 * * *', cacheTtlSeconds: 86_400, wave: 3 },
  idOf: (r) => String(r.organisation_number),
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkCharitiesRecord[]> {
    const records: UkCharitiesRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
