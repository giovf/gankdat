import { z } from 'zod';
import { csvRows } from './csv';
import { queryD1Source, SourceNotLoadedError } from './d1store';
import fixtureRecords from './fixtures/uk-modern-slavery-statements.json';
import { originFetch } from './origin';
import type { DataSource } from './types';

// UK modern slavery statement registry — the Home Office's public register of the
// statements organisations publish under section 54 of the Modern Slavery Act 2015
// (a statutory duty at £36m turnover). The registry itself is VOLUNTARY: a company
// with no row has not broken anything, and nothing here is a compliance verdict.
// Spike `docs/exchange/spikes/uk-esg-disclosure-fields.md` (2026-11-12): OGL v3 on
// every page and file, no access terms; buyers pay for this inside platforms (Sedex,
// EcoVadis) while every shelf copy has one user, so the value is the join on the
// company number — `esg.modern_slavery` on uk-company-profiles and the /diligence
// agent — not a new audience.
//
// Origin: one CSV per registry year at
// `…/publicdownloads/StatementSummaries<year>.csv` (relay rounds
// `pre-research-esg-registers-2026-11-12-c` and `esg-spike-2026-11-12`): 75 columns,
// quoted multi-line cells (addresses, the tick-box lists), ≈ 1.5 KB a row, 17–19 MB
// a full year, regenerated about hourly. A registry year takes submissions from the
// summer before it to well after it closes, so each refresh reads last year's, this
// year's and next year's file (next year's may not exist yet — a 403/404 there is
// skipped, never the other two). Each file is streamed whole in one pass: the spike
// proposed 2 MB Range chunks resumed by byte offset across waves, but a file that is
// rewritten every hour has no stable offsets from one wave to the next, and 17 MB is
// a sixth of the payment practices export wave 5 streams daily.
//
// One row is one organisation covered by one statement: a group statement appears
// once per member, with `parent_name` naming the organisation that submitted it
// (null on the submitter's own row), and three members of one group can each have
// filed a statement covering the other two. So the stable id is the registry's
// statement id (`<code>/<year>` from the summary URL) plus the organisation — the
// company number alone would fold a group's rows into one.
//
// The register accumulates (`append`): a year's rows stay when its file is no longer
// read, and the one-off backfill of earlier years (queue item
// `uk-esg-disclosures-backfill`) writes into the same table.
//
// Blind Mode / what is kept: the organisation-level answers. Dropped at ingest: the
// approving person's name and title, the contact email, the address, every free-text
// `No…Reason`, the "other" text boxes, the three risk narratives (area, tier, group,
// location, mitigation), the ILO indicator texts and the progress narrative.

const FILE_BASE =
  'https://downloads.modern-slavery-statement-registry.service.gov.uk/publicdownloads/StatementSummaries';
const USER_AGENT = 'gankdat.com data refresh';
/** A company has at most a few rows a registry year (its own statement, its group's). */
const JOIN_PAGE = 100;

export const ukModernSlaveryStatementsRecordSchema = z.object({
  /** The registry's statement id, `<code>/<year>` (the path of its summary page). */
  statement_id: z.string(),
  /** The registry year the statement was filed under. */
  statement_year: z.number().int(),
  organisation: z.string(),
  /** `Private` or `Public`. */
  sector_type: z.string().nullable(),
  /** Companies House number as the registry writes it; null for a body without one. */
  company_number: z.string().nullable(),
  /** True when the statement covers a group of organisations. */
  group_submission: z.boolean().nullable(),
  /** The organisation that submitted the group statement; null on the submitter's own row. */
  parent_name: z.string().nullable(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  approved_on: z.string().nullable(),
  last_updated: z.string().nullable(),
  turnover_band: z.string().nullable(),
  /** Sectors the organisation ticked, `; `-separated. */
  sectors: z.string().nullable(),
  years_producing_statements: z.string().nullable(),
  includes_org_structure: z.boolean().nullable(),
  includes_policies: z.boolean().nullable(),
  includes_risk_assessment: z.boolean().nullable(),
  includes_due_diligence: z.boolean().nullable(),
  includes_training: z.boolean().nullable(),
  includes_goals: z.boolean().nullable(),
  /** The registry's tick-box answers, `; `-separated (never the free-text "other" boxes). */
  policies: z.string().nullable(),
  training: z.string().nullable(),
  social_audits: z.string().nullable(),
  grievance_mechanisms: z.string().nullable(),
  /** The statement on the organisation's own site. */
  statement_url: z.string().nullable(),
  /** The registry's summary page of the statement. */
  summary_url: z.string().nullable(),
  /** The copy of the statement the registry holds as a PDF. */
  registry_pdf_url: z.string().nullable(),
});

export type UkModernSlaveryStatementsRecord = z.infer<typeof ukModernSlaveryStatementsRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/[ \t]+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}
/** A multi-line tick-box cell as one `; `-separated line. */
function list(value: string | null): string | null {
  if (value === null) return null;
  const items = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length > 0 ? items.join('; ') : null;
}
function oneLine(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, ' ').trim();
}
function yesNo(v: string | null): boolean | null {
  if (v === null) return null;
  const s = v.toLowerCase();
  return s === 'yes' ? true : s === 'no' ? false : null;
}
/** `dd/mm/yyyy` (the registry's dates) or an ISO stamp → `yyyy-mm-dd`. */
function isoDate(raw: string | null): string | null {
  const uk = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(raw ?? '');
  if (uk) return `${uk[3]}-${uk[2]}-${uk[1]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw ?? '');
  return iso ? iso[1]! : null;
}
function httpUrl(raw: string | null): string | null {
  const value = oneLine(raw);
  return value !== null && /^https?:\/\/\S+$/i.test(value) ? value : null;
}

/** File columns, verbatim (relay `esg-spike-2026-11-12/1.bin`, 2026-11-12). */
const COL = {
  year: 'StatementYear',
  organisation: 'OrganisationName',
  sectorType: 'SectorType',
  number: 'CompanyNumber',
  updated: 'LastUpdated',
  group: 'GroupSubmission',
  parent: 'ParentName',
  statementUrl: 'StatementURL',
  summaryUrl: 'StatementSummaryURL',
  start: 'StatementStartDate',
  end: 'StatementEndDate',
  approved: 'DateApproved',
  orgStructure: 'StatementIncludesOrgStructure',
  policiesIncluded: 'StatementIncludesPolicies',
  risks: 'StatementIncludesRisksAssessment',
  dueDiligence: 'StatementIncludesDueDiligence',
  trainingIncluded: 'StatementIncludesTraining',
  goals: 'StatementIncludesGoals',
  sectors: 'OrganisationSectors',
  turnover: 'Turnover',
  years: 'YearsProducingStatements',
  policies: 'Policies',
  training: 'Training',
  audits: 'SocialAudits',
  grievance: 'GrievanceMechanisms',
  pdf: 'PDFURL',
} as const;

const REQUIRED_COLUMNS = [
  COL.year,
  COL.organisation,
  COL.number,
  COL.group,
  COL.parent,
  COL.summaryUrl,
  COL.end,
  COL.turnover,
] as const;

function normalizeRow(
  cols: string[],
  idx: Map<string, number>,
  fileYear: number,
): UkModernSlaveryStatementsRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  const organisation = oneLine(col(COL.organisation));
  if (organisation === null) return null;
  const yearCell = col(COL.year);
  const year = yearCell !== null && /^\d{4}$/.test(yearCell) ? Number(yearCell) : fileYear;
  const summaryUrl = httpUrl(col(COL.summaryUrl));
  const code = /\/statement-summary\/([^/?#]+)\/(\d{4})/.exec(summaryUrl ?? '');
  const number = oneLine(col(COL.number));
  return {
    statement_id: code ? `${code[1]}/${code[2]}` : `${year}/${organisation.toLowerCase()}`,
    statement_year: year,
    organisation,
    sector_type: oneLine(col(COL.sectorType)),
    company_number: number === null ? null : number.toUpperCase(),
    group_submission: yesNo(col(COL.group)),
    parent_name: oneLine(col(COL.parent)),
    period_start: isoDate(col(COL.start)),
    period_end: isoDate(col(COL.end)),
    approved_on: isoDate(col(COL.approved)),
    last_updated: isoDate(col(COL.updated)),
    turnover_band: oneLine(col(COL.turnover)),
    sectors: list(col(COL.sectors)),
    years_producing_statements: oneLine(col(COL.years)),
    includes_org_structure: yesNo(col(COL.orgStructure)),
    includes_policies: yesNo(col(COL.policiesIncluded)),
    includes_risk_assessment: yesNo(col(COL.risks)),
    includes_due_diligence: yesNo(col(COL.dueDiligence)),
    includes_training: yesNo(col(COL.trainingIncluded)),
    includes_goals: yesNo(col(COL.goals)),
    policies: list(col(COL.policies)),
    training: list(col(COL.training)),
    social_audits: list(col(COL.audits)),
    grievance_mechanisms: list(col(COL.grievance)),
    statement_url: httpUrl(col(COL.statementUrl)),
    summary_url: summaryUrl,
    registry_pdf_url: httpUrl(col(COL.pdf)),
  };
}

/** The registry years one refresh reads: last year's, this year's and next year's file. */
export function registryYears(now: Date): number[] {
  const year = now.getUTCFullYear();
  return [year - 1, year, year + 1];
}

async function* streamYear(
  year: number,
  optional: boolean,
): AsyncGenerator<UkModernSlaveryStatementsRecord> {
  const res = await originFetch(`${FILE_BASE}${year}.csv`, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/csv' },
  });
  if (optional && (res.status === 403 || res.status === 404)) {
    await res.body?.cancel();
    return;
  }
  if (!res.ok || !res.body) {
    throw new Error(`modern slavery statements ${year} file failed: ${res.status}`);
  }
  let idx: Map<string, number> | null = null;
  for await (const row of csvRows(res.body)) {
    if (idx === null) {
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(
          `modern slavery statements ${year} file format changed — missing: ${missing.join(', ')}`,
        );
      }
      continue;
    }
    const record = normalizeRow(row, idx, year);
    if (record) yield record;
  }
}

async function* streamFromOrigin(): AsyncGenerator<UkModernSlaveryStatementsRecord> {
  const years = registryYears(new Date());
  const newest = years[years.length - 1];
  let yielded = 0;
  for (const year of years) {
    for await (const record of streamYear(year, year === newest)) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('modern slavery statement files parsed 0 records');
}

function fixtures(): UkModernSlaveryStatementsRecord[] {
  return z.array(ukModernSlaveryStatementsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(
  env: CloudflareBindings,
): AsyncIterable<UkModernSlaveryStatementsRecord> {
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
          source: 'uk-modern-slavery-statements',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukModernSlaveryStatementsSource: DataSource<UkModernSlaveryStatementsRecord> = {
  slug: 'uk-modern-slavery-statements',
  title: 'UK modern slavery statements (government registry)',
  description:
    'Statement summaries from the UK government modern slavery statement registry — organisation, Companies House number, registry year and statement period, whether it is a group statement and under which parent, turnover band, sectors, how long the organisation has produced statements, the six "statement includes" answers (structure, policies, risk assessment, due diligence, training, goals), the policy, training, audit and grievance tick-boxes, and links to the statement and the registry PDF. By company number with history; refreshed daily. The registry is voluntary, so a company with no row is not thereby non-compliant. Signatory names, contact emails and narrative answers are never ingested.',
  storage: 'd1',
  stats: {
    date: { field: 'last_updated', title: 'Statement summaries by month last updated' },
    groupBy: [
      { field: 'turnover_band', title: 'Statements by turnover band', limit: 10 },
      { field: 'years_producing_statements', title: 'Years producing statements', limit: 10 },
      { field: 'sector_type', title: 'Private and public sector', limit: 5 },
    ],
    noun: 'modern slavery statement summaries',
  },
  recordSchema: ukModernSlaveryStatementsRecordSchema,
  queryParams: z.object({
    company_number: z.string().optional(),
    organisation: z.string().optional(),
    parent_name: z.string().optional(),
    statement_year: z.coerce.number().optional(),
    sector_type: z.string().optional(),
    turnover_band: z.string().optional(),
    sectors: z.string().optional(),
    group_submission: z.stringbool().optional(),
    includes_risk_assessment: z.stringbool().optional(),
    includes_due_diligence: z.stringbool().optional(),
    includes_training: z.stringbool().optional(),
    includes_goals: z.stringbool().optional(),
    period_end_after: z.iso.date().optional(),
    period_end_before: z.iso.date().optional(),
    last_updated_after: z.iso.date().optional(),
    last_updated_before: z.iso.date().optional(),
  }),
  refresh: { cron: '15 5 * * *', cacheTtlSeconds: 86_400, wave: 2 },
  lookupKey: 'company_number',
  append: true,
  idOf: (r) => `${r.statement_id}|${(r.company_number ?? r.organisation).toLowerCase()}`,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkModernSlaveryStatementsRecord[]> {
    const records: UkModernSlaveryStatementsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};

/** The slice of a statement the company lookup carries (`uk-company-profiles.esg.modern_slavery`). */
export const modernSlaverySummarySchema = z.object({
  statement_year: z.number().int(),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
  group_submission: z.boolean().nullable(),
  parent_name: z.string().nullable(),
  turnover_band: z.string().nullable(),
  sectors: z.string().nullable(),
  years_producing_statements: z.string().nullable(),
  includes: z.object({
    org_structure: z.boolean().nullable(),
    policies: z.boolean().nullable(),
    risk_assessment: z.boolean().nullable(),
    due_diligence: z.boolean().nullable(),
    training: z.boolean().nullable(),
    goals: z.boolean().nullable(),
  }),
  statement_url: z.string().nullable(),
  registry_pdf_url: z.string().nullable(),
  /** Every registry year the company has a statement for in this register, oldest first. */
  statement_years: z.array(z.number().int()),
});

export type ModernSlaverySummary = z.infer<typeof modernSlaverySummarySchema>;

/**
 * The company's latest statement on the registry, summarised, or null when it has none there
 * (the registry is voluntary) or the register has not loaded yet. Pinned to the exact number —
 * the generic engine matches substrings. Of the latest year's rows the company's own
 * submission (no parent) is preferred to a group statement filed by another member.
 */
export async function latestModernSlavery(
  env: CloudflareBindings,
  companyNumber: string,
): Promise<ModernSlaverySummary | null> {
  const wanted = companyNumber.trim().toUpperCase();
  if (wanted === '') return null;
  let rows: UkModernSlaveryStatementsRecord[];
  try {
    const result = await queryD1Source(env, ukModernSlaveryStatementsSource, {
      company_number: wanted,
      page: 1,
      per_page: JOIN_PAGE,
    });
    rows = (result.page.records as UkModernSlaveryStatementsRecord[]).filter(
      (r) => r.company_number === wanted,
    );
  } catch (err) {
    if (!(err instanceof SourceNotLoadedError)) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'modern_slavery_join_failed',
          source: 'uk-company-profiles',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return null;
  }
  if (rows.length === 0) return null;
  const rank = (r: UkModernSlaveryStatementsRecord): string =>
    `${r.statement_year}|${r.parent_name === null ? 1 : 0}|${r.last_updated ?? ''}|${r.statement_id}`;
  const latest = rows.reduce((best, r) => (rank(r) > rank(best) ? r : best));
  return {
    statement_year: latest.statement_year,
    period_start: latest.period_start,
    period_end: latest.period_end,
    group_submission: latest.group_submission,
    parent_name: latest.parent_name,
    turnover_band: latest.turnover_band,
    sectors: latest.sectors,
    years_producing_statements: latest.years_producing_statements,
    includes: {
      org_structure: latest.includes_org_structure,
      policies: latest.includes_policies,
      risk_assessment: latest.includes_risk_assessment,
      due_diligence: latest.includes_due_diligence,
      training: latest.includes_training,
      goals: latest.includes_goals,
    },
    statement_url: latest.statement_url,
    registry_pdf_url: latest.registry_pdf_url,
    statement_years: [...new Set(rows.map((r) => r.statement_year))].sort((a, b) => a - b),
  };
}
