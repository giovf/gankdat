import { z } from 'zod';
import { csvRows } from './csv';
import { queryD1Source, SourceNotLoadedError } from './d1store';
import fixtureRecords from './fixtures/uk-gender-pay-gap.json';
import { originFetch } from './origin';
import type { DataSource } from './types';

// UK gender pay gap reports — the figures every employer of 250 or more must publish
// each year under the Equality Act 2010 (Gender Pay Gap Information) Regulations 2017
// (snapshot date 5 April, public sector 31 March; due a year later). Spike
// `docs/exchange/spikes/uk-esg-disclosure-fields.md` (2026-11-12): OGL v3 on every
// page of the service, no access terms; Beauhurst bundles the series into its company
// platform and every shelf copy of the raw files has one user, so the value is the
// join on the company number — `esg.gender_pay_gap` on uk-company-profiles and the
// /diligence agent.
//
// Origin: one CSV per reporting year at `…/viewing/download-data/<year>` where
// <year> is the snapshot year (2025 → "2025 to 2026"; relay rounds
// `pre-research-esg-registers-2026-11-12` and `esg-spike-2026-11-12`): 27 quoted
// columns, ≈ 400 bytes a row, ≈ 4.2 MB and ≈ 10.7k employers a full year, HEAD 405,
// Range ignored — one pass each. A refresh reads the two latest years: the one still
// collecting reports and the one before it, where late reports keep landing. The
// newest year's file may not exist in the first days after a snapshot date, so a
// 404 there is skipped. Stable id: the service's EmployerId plus the reporting year.
//
// The register accumulates (`append`): a year stays when its file is no longer read,
// and the backfill of 2017–2023 (queue item `uk-esg-disclosures-backfill`) writes
// into the same table.
//
// Blind Mode / what is kept: the employer-level figures. Dropped at ingest: the
// responsible person's name and job title, the address and postcode, and the
// employer's own narrative link.

const FILE_BASE = 'https://gender-pay-gap.service.gov.uk/viewing/download-data/';
const USER_AGENT = 'gankdat.com data refresh';
const JOIN_PAGE = 100;

const pct = z.number().nullable();

export const ukGenderPayGapRecordSchema = z.object({
  /** The service's stable employer id. */
  employer_id: z.number().int(),
  /** The snapshot year: 2025 is the 2025/26 reporting year (snapshot 5 April 2025). */
  reporting_year: z.number().int(),
  /** The same year as the service labels it, e.g. `2025/26`. */
  reporting_period: z.string(),
  employer: z.string(),
  /** Companies House number (private and voluntary sector employers only). */
  company_number: z.string().nullable(),
  /** SIC codes, `, `-separated. */
  sic_codes: z.string().nullable(),
  /** Mean gap in hourly pay, % of men's pay (negative = women paid more). */
  mean_hourly_pct: pct,
  median_hourly_pct: pct,
  mean_bonus_pct: pct,
  median_bonus_pct: pct,
  /** Share of men / women who received a bonus. */
  male_bonus_pct: pct,
  female_bonus_pct: pct,
  /** Share of men / women in each pay quartile, lowest to top. */
  male_lower_quartile_pct: pct,
  female_lower_quartile_pct: pct,
  male_lower_middle_quartile_pct: pct,
  female_lower_middle_quartile_pct: pct,
  male_upper_middle_quartile_pct: pct,
  female_upper_middle_quartile_pct: pct,
  male_top_quartile_pct: pct,
  female_top_quartile_pct: pct,
  employer_size: z.string().nullable(),
  submitted_late: z.boolean().nullable(),
  due_date: z.string().nullable(),
  submitted_on: z.string().nullable(),
});

export type UkGenderPayGapRecord = z.infer<typeof ukGenderPayGapRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
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
/** `yyyy/mm/dd hh:mm:ss` (the service's stamps) → `yyyy-mm-dd`. */
function isoDate(raw: string | null): string | null {
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})/.exec(raw ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
/** The file writes several codes as `1,\n84110`. */
function sicCodes(raw: string | null): string | null {
  const codes = (raw ?? '').split(/[,\s]+/).filter((code) => code !== '');
  return codes.length > 0 ? codes.join(', ') : null;
}
/** 2025 → `2025/26`. */
export function reportingPeriod(year: number): string {
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

/** File columns, verbatim (relay `esg-spike-2026-11-12/7.csv`, 2026-11-12). */
const COL = {
  name: 'EmployerName',
  id: 'EmployerId',
  number: 'CompanyNumber',
  sic: 'SicCodes',
  meanHourly: 'DiffMeanHourlyPercent',
  medianHourly: 'DiffMedianHourlyPercent',
  meanBonus: 'DiffMeanBonusPercent',
  medianBonus: 'DiffMedianBonusPercent',
  maleBonus: 'MaleBonusPercent',
  femaleBonus: 'FemaleBonusPercent',
  maleLower: 'MaleLowerQuartile',
  femaleLower: 'FemaleLowerQuartile',
  maleLowerMiddle: 'MaleLowerMiddleQuartile',
  femaleLowerMiddle: 'FemaleLowerMiddleQuartile',
  maleUpperMiddle: 'MaleUpperMiddleQuartile',
  femaleUpperMiddle: 'FemaleUpperMiddleQuartile',
  maleTop: 'MaleTopQuartile',
  femaleTop: 'FemaleTopQuartile',
  size: 'EmployerSize',
  current: 'CurrentName',
  late: 'SubmittedAfterTheDeadline',
  due: 'DueDate',
  submitted: 'DateSubmitted',
} as const;

const REQUIRED_COLUMNS = [
  COL.name,
  COL.id,
  COL.number,
  COL.meanHourly,
  COL.medianHourly,
  COL.size,
  COL.submitted,
] as const;

function normalizeRow(
  cols: string[],
  idx: Map<string, number>,
  year: number,
): UkGenderPayGapRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  const idCell = col(COL.id);
  const employer = col(COL.current) ?? col(COL.name);
  if (idCell === null || !/^\d+$/.test(idCell) || employer === null) return null;
  const employerId = Number(idCell);
  const number = col(COL.number);
  return {
    employer_id: employerId,
    reporting_year: year,
    reporting_period: reportingPeriod(year),
    employer,
    company_number: number === null ? null : number.toUpperCase(),
    sic_codes: sicCodes(col(COL.sic)),
    mean_hourly_pct: numOrNull(col(COL.meanHourly)),
    median_hourly_pct: numOrNull(col(COL.medianHourly)),
    mean_bonus_pct: numOrNull(col(COL.meanBonus)),
    median_bonus_pct: numOrNull(col(COL.medianBonus)),
    male_bonus_pct: numOrNull(col(COL.maleBonus)),
    female_bonus_pct: numOrNull(col(COL.femaleBonus)),
    male_lower_quartile_pct: numOrNull(col(COL.maleLower)),
    female_lower_quartile_pct: numOrNull(col(COL.femaleLower)),
    male_lower_middle_quartile_pct: numOrNull(col(COL.maleLowerMiddle)),
    female_lower_middle_quartile_pct: numOrNull(col(COL.femaleLowerMiddle)),
    male_upper_middle_quartile_pct: numOrNull(col(COL.maleUpperMiddle)),
    female_upper_middle_quartile_pct: numOrNull(col(COL.femaleUpperMiddle)),
    male_top_quartile_pct: numOrNull(col(COL.maleTop)),
    female_top_quartile_pct: numOrNull(col(COL.femaleTop)),
    employer_size: col(COL.size),
    submitted_late: boolOrNull(col(COL.late)),
    due_date: isoDate(col(COL.due)),
    submitted_on: isoDate(col(COL.submitted)),
  };
}

/**
 * The two reporting years one refresh reads, older first: the year whose snapshot date
 * (5 April) has most recently passed, and the one before it.
 */
export function reportingYears(now: Date): number[] {
  const year = now.getUTCFullYear();
  const afterSnapshot = now.getUTCMonth() > 3 || (now.getUTCMonth() === 3 && now.getUTCDate() >= 5);
  const latest = afterSnapshot ? year : year - 1;
  return [latest - 1, latest];
}

async function* streamYear(year: number, optional: boolean): AsyncGenerator<UkGenderPayGapRecord> {
  const res = await originFetch(`${FILE_BASE}${year}`, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/csv' },
  });
  if (optional && res.status === 404) {
    await res.body?.cancel();
    return;
  }
  if (!res.ok || !res.body) throw new Error(`gender pay gap ${year} file failed: ${res.status}`);
  let idx: Map<string, number> | null = null;
  for await (const row of csvRows(res.body)) {
    if (idx === null) {
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(
          `gender pay gap ${year} file format changed — missing: ${missing.join(', ')}`,
        );
      }
      continue;
    }
    const record = normalizeRow(row, idx, year);
    if (record) yield record;
  }
}

async function* streamFromOrigin(): AsyncGenerator<UkGenderPayGapRecord> {
  const years = reportingYears(new Date());
  const newest = years[years.length - 1];
  let yielded = 0;
  for (const year of years) {
    for await (const record of streamYear(year, year === newest)) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('gender pay gap files parsed 0 records');
}

function fixtures(): UkGenderPayGapRecord[] {
  return z.array(ukGenderPayGapRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkGenderPayGapRecord> {
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
          source: 'uk-gender-pay-gap',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukGenderPayGapSource: DataSource<UkGenderPayGapRecord> = {
  slug: 'uk-gender-pay-gap',
  title: 'UK gender pay gap reports (employers of 250+)',
  description:
    'The gender pay gap figures UK employers of 250 or more publish each year — employer, Companies House number, SIC codes, reporting year, mean and median hourly pay gap, mean and median bonus gap, the share of men and women paid a bonus and in each pay quartile, employer size band, due and submission dates and whether the report was late. By company number with history across years; from the official GOV.UK gender pay gap service, refreshed daily. The responsible person and the address are never ingested.',
  storage: 'd1',
  stats: {
    date: { field: 'submitted_on', title: 'Reports submitted by month' },
    groupBy: [
      { field: 'employer_size', title: 'Reports by employer size', limit: 10 },
      { field: 'reporting_period', title: 'Reports by reporting year', limit: 12, sort: 'value' },
    ],
    noun: 'gender pay gap reports',
  },
  recordSchema: ukGenderPayGapRecordSchema,
  queryParams: z.object({
    company_number: z.string().optional(),
    employer: z.string().optional(),
    employer_id: z.coerce.number().int().optional(),
    reporting_year: z.coerce.number().optional(),
    sic_codes: z.string().optional(),
    employer_size: z.string().optional(),
    submitted_late: z.stringbool().optional(),
    mean_hourly_pct_min: z.coerce.number().optional(),
    mean_hourly_pct_max: z.coerce.number().optional(),
    median_hourly_pct_min: z.coerce.number().optional(),
    median_hourly_pct_max: z.coerce.number().optional(),
    submitted_on_after: z.iso.date().optional(),
    submitted_on_before: z.iso.date().optional(),
  }),
  refresh: { cron: '15 5 * * *', cacheTtlSeconds: 86_400, wave: 2 },
  lookupKey: 'company_number',
  append: true,
  idOf: (r) => `${r.employer_id}|${r.reporting_year}`,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkGenderPayGapRecord[]> {
    const records: UkGenderPayGapRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};

/** The slice of a report the company lookup carries (`uk-company-profiles.esg.gender_pay_gap`). */
export const genderPayGapSummarySchema = z.object({
  reporting_year: z.number().int(),
  reporting_period: z.string(),
  mean_hourly_pct: pct,
  median_hourly_pct: pct,
  mean_bonus_pct: pct,
  median_bonus_pct: pct,
  employer_size: z.string().nullable(),
  submitted_late: z.boolean().nullable(),
  submitted_on: z.string().nullable(),
  /** How many reporting years the register holds for the company. */
  reports: z.number().int(),
});

export type GenderPayGapSummary = z.infer<typeof genderPayGapSummarySchema>;

/**
 * The company's latest gender pay gap report, summarised, or null when it has none (under 250
 * employees, a public body without a company number) or the register has not loaded yet.
 * Pinned to the exact number — the generic engine matches substrings.
 */
export async function latestGenderPayGap(
  env: CloudflareBindings,
  companyNumber: string,
): Promise<GenderPayGapSummary | null> {
  const wanted = companyNumber.trim().toUpperCase();
  if (wanted === '') return null;
  let rows: UkGenderPayGapRecord[];
  try {
    const result = await queryD1Source(env, ukGenderPayGapSource, {
      company_number: wanted,
      page: 1,
      per_page: JOIN_PAGE,
    });
    rows = (result.page.records as UkGenderPayGapRecord[]).filter(
      (r) => r.company_number === wanted,
    );
  } catch (err) {
    if (!(err instanceof SourceNotLoadedError)) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'gender_pay_gap_join_failed',
          source: 'uk-company-profiles',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return null;
  }
  if (rows.length === 0) return null;
  const latest = rows.reduce((best, r) =>
    r.reporting_year > best.reporting_year ||
    (r.reporting_year === best.reporting_year && r.employer_id > best.employer_id)
      ? r
      : best,
  );
  return {
    reporting_year: latest.reporting_year,
    reporting_period: latest.reporting_period,
    mean_hourly_pct: latest.mean_hourly_pct,
    median_hourly_pct: latest.median_hourly_pct,
    mean_bonus_pct: latest.mean_bonus_pct,
    median_bonus_pct: latest.median_bonus_pct,
    employer_size: latest.employer_size,
    submitted_late: latest.submitted_late,
    submitted_on: latest.submitted_on,
    reports: new Set(rows.map((r) => r.reporting_year)).size,
  };
}
