import { z } from 'zod';
import { csvRows } from './csv';
import { queryD1Source, SourceNotLoadedError } from './d1store';
import fixtureRecords from './fixtures/uk-payment-practices.json';
import { originFetch } from './origin';
import type { DataSource } from './types';

// UK payment practices reports — the statutory twice-yearly report every large UK
// company and LLP (two of: £54m turnover, £27m balance sheet, 250 employees) files
// under the Reporting on Payment Practices and Performance Regulations 2017
// (SI 2017/395): how long it takes to pay its suppliers and what share it pays
// late. Spike `docs/exchange/spikes/uk-payment-practices-lookup.md` (2026-11-12,
// exchange pre-research of the same night): OGL v3 on every page of the service,
// no access terms; Experian sells the payment insight at £24.99 a report and an
// api.market API wraps this same export at US$49–399/month with one user, so the
// value here is the join — the company number every other gankdat register and the
// /diligence agent share — not a new audience.
//
// Origin: the service's one-click export, a CSV generated per request (filename
// stamped with the request minute, no Content-Length, HEAD 405, Range ignored —
// relay rounds `pre-research-payment-practices-2026-11-12[-b]` and
// `payment-practices-spike-2026-11-12`): 52 columns, ≈ 115k reports (ids 2 →
// 118366 with ≈ 3 % gaps), ≈ 863 bytes a row → ≈ 100 MB, streamed in one pass
// through `csvRows()` like the charity extract (160 MB in wave 3). Stable id: the
// Report Id. Reports land twice a year per company, so the delta refresh writes a
// few hundred new rows a day at most; the platform's waves are daily, and the
// source rides wave 5 (05:50) beside uk-schools, the lightest of the big waves.
//
// Blind Mode / what is kept: the statistics and yes/no policy answers the export
// publishes for re-use. Dropped at ingest: every narrative column (standard terms
// text, maximum-period and other-information text, retention-clause descriptions
// and amounts, the dispute-resolution process — free text that can name a person)
// and the total-value columns. Organisation level only; the report's approver is
// not in the export at all.

const EXPORT_URL = 'https://check-payment-practices.service.gov.uk/export/csv/';
const REPORT_URL = 'https://check-payment-practices.service.gov.uk/report/';
const USER_AGENT = 'gankdat.com data refresh';
/** The companies the join reads at most — a company has ≈ 2 reports a year since 2017. */
const JOIN_PAGE = 100;

export const ukPaymentPracticesRecordSchema = z.object({
  /** The service's stable report id (`/report/<id>/`). */
  report_id: z.number().int(),
  /** Companies House number, as the export writes it (zero-padded, or a two-letter prefix). */
  company_number: z.string(),
  company: z.string(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  filed_on: z.string().nullable(),
  /** Average number of days taken to pay invoices in the period. */
  average_days_to_pay: z.number().int().nullable(),
  paid_within_30_days_pct: z.number().nullable(),
  paid_31_to_60_days_pct: z.number().nullable(),
  paid_after_60_days_pct: z.number().nullable(),
  /** Share of invoices not paid within the agreed terms — the "paid late" figure. */
  not_paid_within_terms_pct: z.number().nullable(),
  disputed_pct: z.number().nullable(),
  shortest_standard_terms_days: z.number().int().nullable(),
  longest_standard_terms_days: z.number().int().nullable(),
  max_contractual_days: z.number().int().nullable(),
  terms_changed: z.boolean().nullable(),
  suppliers_notified: z.boolean().nullable(),
  qualifying_contracts: z.boolean().nullable(),
  payments_made: z.boolean().nullable(),
  construction_contracts: z.boolean().nullable(),
  construction_retention_clauses: z.boolean().nullable(),
  /** Signatory of a payment code (the Prompt Payment Code / Fair Payment Code). */
  participates_in_payment_codes: z.boolean().nullable(),
  e_invoicing_offered: z.boolean().nullable(),
  supply_chain_financing_offered: z.boolean().nullable(),
  supplier_list_charges_policy: z.boolean().nullable(),
  supplier_list_charges_made: z.boolean().nullable(),
  report_url: z.string(),
});

export type UkPaymentPracticesRecord = z.infer<typeof ukPaymentPracticesRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' || trimmed === 'None' ? null : trimmed;
}
function intOrNull(v: string | null): number | null {
  return v !== null && /^-?\d+$/.test(v) ? Number(v) : null;
}
function numOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
/** The export mixes `True`/`False` and `Yes`/`No` (the payment-codes column). */
function boolOrNull(v: string | null): boolean | null {
  if (v === null) return null;
  const s = v.toLowerCase();
  return s === 'true' || s === 'yes' ? true : s === 'false' || s === 'no' ? false : null;
}
function isoDate(raw: string | null): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw ?? '');
  return m ? m[1]! : null;
}

/** Export columns, verbatim (relay `payment-practices-spike-2026-11-12/1.csv`, 2026-11-12). */
const COL = {
  id: 'Report Id',
  start: 'Start date',
  end: 'End date',
  filed: 'Filing date',
  company: 'Company',
  number: 'Company number',
  qualifying: 'Qualifying contracts in reporting period',
  payments: 'Payments made in reporting period',
  construction: 'Qualifying construction contracts in reporting period',
  retention: 'Construction contracts have retention clauses',
  average: 'Average time to pay',
  within30: '% Invoices paid within 30 days',
  within60: '% Invoices paid between 31 and 60 days',
  after60: '% Invoices paid later than 60 days',
  late: '% Invoices not paid within agreed terms',
  disputed: '% Invoices not paid due to dispute',
  shortest: 'Shortest (or only) standard payment period',
  longest: 'Longest standard payment period',
  changed: 'Payment terms have changed',
  notified: 'Suppliers notified of changes',
  maximum: 'Maximum contractual payment period',
  codes: 'Participates in payment codes',
  einvoicing: 'E-Invoicing offered',
  financing: 'Supply-chain financing offered',
  chargesPolicy: 'Policy covers charges for remaining on supplier list',
  chargesMade: 'Charges have been made for remaining on supplier list',
  url: 'URL',
} as const;

const REQUIRED_COLUMNS = [
  COL.id,
  COL.number,
  COL.company,
  COL.start,
  COL.end,
  COL.filed,
  COL.average,
  COL.late,
] as const;

function normalizeRow(cols: string[], idx: Map<string, number>): UkPaymentPracticesRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  const reportId = intOrNull(col(COL.id));
  const number = col(COL.number);
  const company = col(COL.company);
  if (reportId === null || number === null || company === null) return null;
  return {
    report_id: reportId,
    company_number: number.toUpperCase(),
    company,
    period_start: isoDate(col(COL.start)),
    period_end: isoDate(col(COL.end)),
    filed_on: isoDate(col(COL.filed)),
    average_days_to_pay: intOrNull(col(COL.average)),
    paid_within_30_days_pct: numOrNull(col(COL.within30)),
    paid_31_to_60_days_pct: numOrNull(col(COL.within60)),
    paid_after_60_days_pct: numOrNull(col(COL.after60)),
    not_paid_within_terms_pct: numOrNull(col(COL.late)),
    disputed_pct: numOrNull(col(COL.disputed)),
    shortest_standard_terms_days: intOrNull(col(COL.shortest)),
    longest_standard_terms_days: intOrNull(col(COL.longest)),
    max_contractual_days: intOrNull(col(COL.maximum)),
    terms_changed: boolOrNull(col(COL.changed)),
    suppliers_notified: boolOrNull(col(COL.notified)),
    qualifying_contracts: boolOrNull(col(COL.qualifying)),
    payments_made: boolOrNull(col(COL.payments)),
    construction_contracts: boolOrNull(col(COL.construction)),
    construction_retention_clauses: boolOrNull(col(COL.retention)),
    participates_in_payment_codes: boolOrNull(col(COL.codes)),
    e_invoicing_offered: boolOrNull(col(COL.einvoicing)),
    supply_chain_financing_offered: boolOrNull(col(COL.financing)),
    supplier_list_charges_policy: boolOrNull(col(COL.chargesPolicy)),
    supplier_list_charges_made: boolOrNull(col(COL.chargesMade)),
    report_url: col(COL.url) ?? `${REPORT_URL}${reportId}`,
  };
}

async function* streamFromOrigin(): AsyncGenerator<UkPaymentPracticesRecord> {
  const res = await originFetch(EXPORT_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/csv' },
  });
  if (!res.ok || !res.body) throw new Error(`payment practices export failed: ${res.status}`);
  let idx: Map<string, number> | null = null;
  let yielded = 0;
  for await (const row of csvRows(res.body)) {
    if (idx === null) {
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(`payment practices export format changed — missing: ${missing.join(', ')}`);
      }
      continue;
    }
    const record = normalizeRow(row, idx);
    if (record) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('payment practices export parsed 0 records');
}

function fixtures(): UkPaymentPracticesRecord[] {
  return z.array(ukPaymentPracticesRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkPaymentPracticesRecord> {
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
          source: 'uk-payment-practices',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukPaymentPracticesSource: DataSource<UkPaymentPracticesRecord> = {
  slug: 'uk-payment-practices',
  title: 'UK payment practices reports (large companies)',
  description:
    'Every statutory payment practices report filed by a large UK company or LLP since 2017 — company number and name, reporting period and filing date, average days to pay, the share of invoices paid within 30 / 31–60 / over 60 days, the share not paid within agreed terms and disputed, shortest and longest standard terms, maximum contractual period, and the yes/no policy answers (payment code, e-invoicing, supply-chain finance, supplier-list charges). Latest report and history by company number; from the official GOV.UK export, refreshed daily. Narrative answers are never ingested.',
  storage: 'd1',
  stats: {
    date: { field: 'filed_on', title: 'Reports filed by month' },
    groupBy: [{ field: 'company', title: 'Companies with the most reports', limit: 15 }],
    noun: 'payment practices reports',
  },
  recordSchema: ukPaymentPracticesRecordSchema,
  queryParams: z.object({
    company_number: z.string().optional(),
    company: z.string().optional(),
    report_id: z.coerce.number().int().optional(),
    period_end_after: z.iso.date().optional(),
    period_end_before: z.iso.date().optional(),
    filed_on_after: z.iso.date().optional(),
    filed_on_before: z.iso.date().optional(),
    average_days_to_pay_min: z.coerce.number().optional(),
    average_days_to_pay_max: z.coerce.number().optional(),
    not_paid_within_terms_pct_min: z.coerce.number().optional(),
    not_paid_within_terms_pct_max: z.coerce.number().optional(),
    paid_after_60_days_pct_min: z.coerce.number().optional(),
    participates_in_payment_codes: z.stringbool().optional(),
    e_invoicing_offered: z.stringbool().optional(),
    supply_chain_financing_offered: z.stringbool().optional(),
  }),
  refresh: { cron: '50 5 * * *', cacheTtlSeconds: 86_400, wave: 5 },
  idOf: (r) => String(r.report_id),
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkPaymentPracticesRecord[]> {
    const records: UkPaymentPracticesRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};

/** The slice of a report the company lookup carries (`uk-company-profiles.payment_practices`). */
export const paymentPracticesSummarySchema = z.object({
  report_id: z.number().int(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  filed_on: z.string().nullable(),
  average_days_to_pay: z.number().int().nullable(),
  paid_within_30_days_pct: z.number().nullable(),
  paid_31_to_60_days_pct: z.number().nullable(),
  paid_after_60_days_pct: z.number().nullable(),
  not_paid_within_terms_pct: z.number().nullable(),
  disputed_pct: z.number().nullable(),
  participates_in_payment_codes: z.boolean().nullable(),
  /** How many reports the company has filed in all. */
  reports: z.number().int(),
  report_url: z.string(),
});

export type PaymentPracticesSummary = z.infer<typeof paymentPracticesSummarySchema>;

/**
 * The company's latest report, summarised, or null when it has never reported (not a large
 * company, or the register has not loaded yet). One D1 read over the live generation; the
 * lookup caches the whole record for 24 h, so a company costs this read once a day at most.
 * The generic engine matches `company_number` as a substring, so the rows are pinned to the
 * exact number here, and the latest is the newest period end (then the highest id).
 */
export async function latestPaymentPractices(
  env: CloudflareBindings,
  companyNumber: string,
): Promise<PaymentPracticesSummary | null> {
  const wanted = companyNumber.trim().toUpperCase();
  if (wanted === '') return null;
  let rows: UkPaymentPracticesRecord[];
  try {
    const result = await queryD1Source(env, ukPaymentPracticesSource, {
      company_number: wanted,
      page: 1,
      per_page: JOIN_PAGE,
    });
    rows = (result.page.records as UkPaymentPracticesRecord[]).filter(
      (r) => r.company_number === wanted,
    );
  } catch (err) {
    if (!(err instanceof SourceNotLoadedError)) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'payment_practices_join_failed',
          source: 'uk-company-profiles',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return null;
  }
  if (rows.length === 0) return null;
  const latest = rows.reduce((best, r) => {
    const a = r.period_end ?? '';
    const b = best.period_end ?? '';
    return a > b || (a === b && r.report_id > best.report_id) ? r : best;
  });
  return {
    report_id: latest.report_id,
    period_start: latest.period_start,
    period_end: latest.period_end,
    filed_on: latest.filed_on,
    average_days_to_pay: latest.average_days_to_pay,
    paid_within_30_days_pct: latest.paid_within_30_days_pct,
    paid_31_to_60_days_pct: latest.paid_31_to_60_days_pct,
    paid_after_60_days_pct: latest.paid_after_60_days_pct,
    not_paid_within_terms_pct: latest.not_paid_within_terms_pct,
    disputed_pct: latest.disputed_pct,
    participates_in_payment_codes: latest.participates_in_payment_codes,
    reports: rows.length,
    report_url: latest.report_url,
  };
}
