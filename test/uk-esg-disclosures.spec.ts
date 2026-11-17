import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import {
  latestGenderPayGap,
  reportingPeriod,
  reportingYears,
  ukGenderPayGapSource,
} from '../src/sources/uk-gender-pay-gap';
import type { UkGenderPayGapRecord } from '../src/sources/uk-gender-pay-gap';
import {
  latestModernSlavery,
  registryYears,
  ukModernSlaveryStatementsSource,
} from '../src/sources/uk-modern-slavery-statements';
import type { UkModernSlaveryStatementsRecord } from '../src/sources/uk-modern-slavery-statements';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';
import { chunked } from './uk-payment-practices.spec';

const MS_URL = 'https://example.com/v1/data/uk-modern-slavery-statements';
const GPG_URL = 'https://example.com/v1/data/uk-gender-pay-gap';
const SUMMARY = 'https://modern-slavery-statement-registry.service.gov.uk/statement-summary/';
const PDF = 'https://downloads.modern-slavery-statement-registry.service.gov.uk/pdf-published/';

const [LAST, THIS] = registryYears(new Date()) as [number, number, number];
const [OLDER, NEWER] = reportingYears(new Date()) as [number, number];

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}
function csvOf(header: string, rows: Record<string, string>[], quoteAll = false): string {
  const columns = header.split(',');
  const line = (cells: string[]): string =>
    cells.map((cell) => (quoteAll ? `"${cell.replace(/"/g, '""')}"` : quote(cell))).join(',');
  return (
    [line(columns), ...rows.map((r) => line(columns.map((c) => r[c] ?? '')))].join('\r\n') + '\r\n'
  );
}

// The statement summaries file's 75 columns, verbatim (relay esg-spike-2026-11-12/1.bin).
const MS_HEADER =
  'StatementYear,OrganisationName,Address,SectorType,CompanyNumber,LastUpdated,GroupSubmission,ParentName,StatementURL,EmailAddressNoURL,StatementSummaryURL,StatementStartDate,StatementEndDate,ApprovingPerson,DateApproved,StatementIncludesOrgStructure,NoOrgStructureReason,StatementIncludesPolicies,NoPoliciesReason,StatementIncludesRisksAssessment,NoRiskAssessmentReason,StatementIncludesDueDiligence,NoDueDiligenceReason,StatementIncludesTraining,NoTrainingReason,StatementIncludesGoals,NoGoalsReason,OrganisationSectors,OtherOrganisationSector,PublicSectorAuthorities,OtherPublicSectorAuthorities,Turnover,YearsProducingStatements,Policies,OtherPolicies,NoPolicies,Training,OtherTraining,NoTraining,WorkingConditionsEngagement,NoEngagement,SocialAudits,NoSocialAudits,GrievanceMechanisms,NoGrievanceMechanisms,OtherMonitoring,NoRisks,Risk1,Risk1Area,Risk1SupplyChainTier,Risk1GroupAffected,Risk1OtherGroupAffected,Risk1Location,Risk1Mitigation,Risk2,Risk2Area,Risk2SupplyChainTier,Risk2GroupAffected,Risk2OtherGroupAffected,Risk2Location,Risk2Mitigation,Risk3,Risk3Area,Risk3SupplyChainTier,Risk3GroupAffected,Risk3OtherGroupAffected,Risk3Location,Risk3Mitigation,ILOIndicatorsInStatement,NoILOIndicatorsInStatement,ILOIndicatorsActions,ILOIndicatorsNoActions,DemonstrateProgress,PDFDate,PDFURL';

/** A statement row; the personal and narrative columns carry text that must never be served. */
function statement(cells: Record<string, string>): Record<string, string> {
  return {
    SectorType: 'Private',
    LastUpdated: '09/06/2026',
    GroupSubmission: 'No',
    Address: 'Unit 4\nMill Lane\nLeeds',
    EmailAddressNoURL: 'jane.doe@example.com',
    ApprovingPerson: 'Jane Doe (Managing Director)',
    StatementStartDate: '01/01/2025',
    StatementEndDate: '31/12/2025',
    DateApproved: '26/05/2026',
    StatementIncludesOrgStructure: 'Yes',
    StatementIncludesPolicies: 'Yes',
    StatementIncludesRisksAssessment: 'Yes',
    StatementIncludesDueDiligence: 'Yes',
    StatementIncludesTraining: 'No',
    NoTrainingReason: 'Our trainer, Mr Smith, left the business',
    StatementIncludesGoals: 'No',
    Turnover: '£36 million to £60 million',
    YearsProducingStatements: '1 to 5 years',
    Risk1: 'Cotton sourcing through an agent in Region X',
    Risk1Mitigation: 'Site visits by our buyer',
    DemonstrateProgress: 'sets process goals and monitors',
    ...cells,
  };
}

const WIDGETS_OWN = statement({
  StatementYear: String(THIS),
  OrganisationName: 'EXAMPLE WIDGETS LIMITED',
  CompanyNumber: '12345678',
  StatementURL: 'https://widgets.example/modern-slavery',
  StatementSummaryURL: `${SUMMARY}AAAA1111/${THIS}`,
  OrganisationSectors: 'Manufacturing\nTransportation, logistics, and storage',
  Policies: 'Freedom of movement\nProhibits child labour',
  OtherPolicies: 'A private note about a named supplier',
  Training: 'Procurement staff',
  SocialAudits: 'Audit conducted by your staff\nAnnounced audit',
  GrievanceMechanisms: 'Through trade unions or other worker representative groups',
  PDFDate: '2026-06-09T08:01:51',
  PDFURL: `${PDF}AAAA1111/${THIS}/widgets.pdf`,
});
const WIDGETS_IN_GROUP = statement({
  StatementYear: String(THIS),
  OrganisationName: 'EXAMPLE WIDGETS LIMITED',
  CompanyNumber: '12345678',
  LastUpdated: '30/06/2026',
  GroupSubmission: 'Yes',
  ParentName: 'EXAMPLE GROUP PLC',
  StatementSummaryURL: `${SUMMARY}BBBB2222/${THIS}`,
  Turnover: 'Over £500 million',
});
const GROUP_OWN = statement({
  StatementYear: String(THIS),
  OrganisationName: 'EXAMPLE GROUP PLC',
  CompanyNumber: '87654321',
  LastUpdated: '30/06/2026',
  GroupSubmission: 'Yes',
  StatementSummaryURL: `${SUMMARY}BBBB2222/${THIS}`,
  Turnover: 'Over £500 million',
  YearsProducingStatements: 'More than 5 years',
  StatementIncludesGoals: 'Yes',
});
const FIRE = statement({
  StatementYear: String(THIS),
  OrganisationName: 'Example Fire Authority',
  SectorType: 'Public',
  StatementSummaryURL: `${SUMMARY}CCCC3333/${THIS}`,
  Turnover: 'Under £36 million',
});
const WIDGETS_LAST = statement({
  StatementYear: String(LAST),
  OrganisationName: 'EXAMPLE WIDGETS LIMITED',
  CompanyNumber: '12345678',
  LastUpdated: '02/05/2025',
  StatementStartDate: '01/01/2024',
  StatementEndDate: '31/12/2024',
  StatementSummaryURL: `${SUMMARY}AAAA1111/${LAST}`,
});

const MS_THIS = csvOf(MS_HEADER, [WIDGETS_OWN, WIDGETS_IN_GROUP, GROUP_OWN, FIRE]);
const MS_LAST = csvOf(MS_HEADER, [WIDGETS_LAST]);

/** Last year's and this year's files; next year's is not open yet (404). */
export function modernSlaveryOrigin(year: number): Response {
  if (year === THIS) return chunked('﻿' + MS_THIS);
  if (year === LAST) return chunked(MS_LAST);
  return new Response('Not Found', { status: 404 });
}

// The pay gap file's 27 columns, verbatim and all quoted (relay esg-spike-2026-11-12/7.csv).
const GPG_HEADER =
  'EmployerName,EmployerId,Address,PostCode,CompanyNumber,SicCodes,DiffMeanHourlyPercent,DiffMedianHourlyPercent,DiffMeanBonusPercent,DiffMedianBonusPercent,MaleBonusPercent,FemaleBonusPercent,MaleLowerQuartile,FemaleLowerQuartile,MaleLowerMiddleQuartile,FemaleLowerMiddleQuartile,MaleUpperMiddleQuartile,FemaleUpperMiddleQuartile,MaleTopQuartile,FemaleTopQuartile,CompanyLinkToGPGInfo,ResponsiblePerson,EmployerSize,CurrentName,SubmittedAfterTheDeadline,DueDate,DateSubmitted';

function report(cells: Record<string, string>): Record<string, string> {
  return {
    Address: 'Unit 4, Mill Lane, Leeds, LS1 1AA',
    PostCode: 'LS1 1AA',
    ResponsiblePerson: 'Jane Doe (HR Director)',
    CompanyLinkToGPGInfo: 'https://widgets.example/pay-gap',
    MaleLowerQuartile: '48.3',
    FemaleLowerQuartile: '51.7',
    MaleTopQuartile: '53.0',
    FemaleTopQuartile: '47.0',
    EmployerSize: '250 to 499',
    SubmittedAfterTheDeadline: 'False',
    ...cells,
  };
}
const GPG_OLDER = csvOf(
  GPG_HEADER,
  [
    report({
      EmployerName: 'EXAMPLE WIDGETS LTD',
      CurrentName: 'EXAMPLE WIDGETS LIMITED',
      EmployerId: '501',
      CompanyNumber: '12345678',
      SicCodes: '25990',
      DiffMeanHourlyPercent: '14.2',
      DiffMedianHourlyPercent: '9.0',
      DueDate: `${OLDER + 1}/04/05 00:00:00`,
      DateSubmitted: `${OLDER + 1}/03/27 13:34:41`,
    }),
  ],
  true,
);
const GPG_NEWER = csvOf(
  GPG_HEADER,
  [
    report({
      EmployerName: 'EXAMPLE WIDGETS LIMITED',
      CurrentName: 'EXAMPLE WIDGETS LIMITED',
      EmployerId: '501',
      CompanyNumber: '12345678',
      SicCodes: '1,\n25990',
      DiffMeanHourlyPercent: '11.5',
      DiffMedianHourlyPercent: '-2.3',
      DiffMeanBonusPercent: '30',
      DiffMedianBonusPercent: '',
      MaleBonusPercent: '12.5',
      FemaleBonusPercent: '10',
      DueDate: `${NEWER + 1}/04/05 00:00:00`,
      DateSubmitted: `${NEWER + 1}/04/20 09:00:00`,
      SubmittedAfterTheDeadline: 'True',
    }),
    report({
      EmployerName: 'Example Fire Authority',
      CurrentName: 'Example Fire Authority',
      EmployerId: '777',
      DiffMeanHourlyPercent: '3',
      DiffMedianHourlyPercent: '0',
      EmployerSize: '1000 to 4999',
      DueDate: `${NEWER + 1}/03/31 00:00:00`,
      DateSubmitted: `${NEWER + 1}/03/01 10:00:00`,
    }),
    report({ EmployerName: 'NO ID LIMITED', CurrentName: 'NO ID LIMITED', EmployerId: '' }),
  ],
  true,
);

export function genderPayGapOrigin(year: number): Response {
  if (year === NEWER) return chunked('﻿' + GPG_NEWER);
  if (year === OLDER) return chunked(GPG_OLDER);
  return new Response('Not Found', { status: 404 });
}

async function lastLog(slug: string): Promise<{ status: string; message: string | null } | null> {
  return env.DB.prepare(
    'SELECT status, message FROM refresh_log WHERE source_slug = ?1 ORDER BY id DESC LIMIT 1',
  )
    .bind(slug)
    .first<{ status: string; message: string | null }>();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('year windows', () => {
  it('reads last, this and next registry year, and the two pay gap years past their snapshot', () => {
    expect(registryYears(new Date('2026-11-17T05:15:00Z'))).toEqual([2025, 2026, 2027]);
    expect(reportingYears(new Date('2026-11-17T05:15:00Z'))).toEqual([2025, 2026]);
    expect(reportingYears(new Date('2027-04-04T05:15:00Z'))).toEqual([2025, 2026]);
    expect(reportingYears(new Date('2027-04-05T05:15:00Z'))).toEqual([2026, 2027]);
    expect(reportingPeriod(2025)).toBe('2025/26');
    expect(reportingPeriod(2099)).toBe('2099/00');
  });
});

describe('GET /v1/data/uk-modern-slavery-statements', () => {
  it('reads each open year, keeps organisation-level answers, never people or narrative', async () => {
    const mock = stubOrigins({ modernSlavery: modernSlaveryOrigin });
    await refreshD1Source(env, ukModernSlaveryStatementsSource);
    expect(mock.mock.calls).toHaveLength(3); // last, this, next (404, skipped)
    const res = await authedFetch(`${MS_URL}?per_page=50`);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const banned of [
      'Jane Doe',
      'jane.doe',
      'Mill Lane',
      'Mr Smith',
      'Region X',
      'Site visits',
      'named supplier',
      'process goals',
    ]) {
      expect(text).not.toContain(banned);
    }
    const body = JSON.parse(text) as SuccessEnvelope<UkModernSlaveryStatementsRecord[]>;
    expect(body.data).toHaveLength(5);
    expect(body.data.find((r) => r.statement_id === `AAAA1111/${THIS}`)).toEqual({
      statement_id: `AAAA1111/${THIS}`,
      statement_year: THIS,
      organisation: 'EXAMPLE WIDGETS LIMITED',
      sector_type: 'Private',
      company_number: '12345678',
      group_submission: false,
      parent_name: null,
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      approved_on: '2026-05-26',
      last_updated: '2026-06-09',
      turnover_band: '£36 million to £60 million',
      sectors: 'Manufacturing; Transportation, logistics, and storage',
      years_producing_statements: '1 to 5 years',
      includes_org_structure: true,
      includes_policies: true,
      includes_risk_assessment: true,
      includes_due_diligence: true,
      includes_training: false,
      includes_goals: false,
      policies: 'Freedom of movement; Prohibits child labour',
      training: 'Procurement staff',
      social_audits: 'Audit conducted by your staff; Announced audit',
      grievance_mechanisms: 'Through trade unions or other worker representative groups',
      statement_url: 'https://widgets.example/modern-slavery',
      summary_url: `${SUMMARY}AAAA1111/${THIS}`,
      registry_pdf_url: `${PDF}AAAA1111/${THIS}/widgets.pdf`,
    });
    // One group statement is one row per member: same statement id, two organisations.
    const group = body.data.filter((r) => r.statement_id === `BBBB2222/${THIS}`);
    expect(group.map((r) => [r.company_number, r.parent_name]).sort()).toEqual([
      ['12345678', 'EXAMPLE GROUP PLC'],
      ['87654321', null],
    ]);
    const fire = body.data.find((r) => r.organisation === 'Example Fire Authority');
    expect(fire?.company_number).toBeNull();
    expect(fire?.sector_type).toBe('Public');
  });

  it('filters by company number, year, group and turnover band', async () => {
    stubOrigins({ modernSlavery: modernSlaveryOrigin });
    await refreshD1Source(env, ukModernSlaveryStatementsSource);
    const { key } = await issueKey();
    const ids = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${MS_URL}?${qs}`, key)).json()) as SuccessEnvelope<
        UkModernSlaveryStatementsRecord[]
      >;
      return body.data.map((r) => `${r.statement_id}:${r.company_number ?? '-'}`).sort();
    };
    expect(await ids('company_number=12345678')).toEqual(
      [
        `AAAA1111/${LAST}:12345678`,
        `AAAA1111/${THIS}:12345678`,
        `BBBB2222/${THIS}:12345678`,
      ].sort(),
    );
    expect(await ids(`company_number=12345678&statement_year=${LAST}`)).toEqual([
      `AAAA1111/${LAST}:12345678`,
    ]);
    expect(await ids('group_submission=true&turnover_band=over')).toEqual(
      [`BBBB2222/${THIS}:12345678`, `BBBB2222/${THIS}:87654321`].sort(),
    );
    expect(await ids('sector_type=public')).toEqual([`CCCC3333/${THIS}:-`]);
    expect(await ids('sectors=logistics')).toEqual([`AAAA1111/${THIS}:12345678`]);
    expect(await ids('includes_goals=true')).toEqual([`BBBB2222/${THIS}:87654321`]);
  });

  it('accumulates: a second identical read writes nothing, and a failed required year is an error', async () => {
    stubOrigins({ modernSlavery: modernSlaveryOrigin });
    await refreshD1Source(env, ukModernSlaveryStatementsSource);
    expect((await lastLog('uk-modern-slavery-statements'))?.message).toMatch(/^append \+5 ~0/);
    await refreshD1Source(env, ukModernSlaveryStatementsSource);
    expect((await lastLog('uk-modern-slavery-statements'))?.message).toMatch(/^append \+0 ~0/);
    // This year's file gone: last year's rows were read, so no fixture fallback — an error row,
    // and the register keeps every row it had.
    stubOrigins({
      modernSlavery: (year) =>
        year === THIS ? new Response('nope', { status: 503 }) : modernSlaveryOrigin(year),
    });
    await expect(refreshD1Source(env, ukModernSlaveryStatementsSource)).rejects.toThrow(
      new RegExp(`${THIS} file failed: 503`),
    );
    const body = (await (await authedFetch(MS_URL)).json()) as SuccessEnvelope<unknown[]>;
    expect(body.meta?.total).toBe(5);
  });

  it('treats a lost required column as a failed origin (fixtures in the test env)', async () => {
    stubOrigins({
      modernSlavery: () => chunked(MS_LAST.replace('StatementSummaryURL', 'SummaryLink')),
    });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await refreshD1Source(env, ukModernSlaveryStatementsSource);
    expect(logs.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /fixture_fallback.*format changed — missing: StatementSummaryURL/,
    );
    logs.mockRestore();
    const body = (await (await authedFetch(MS_URL)).json()) as SuccessEnvelope<unknown[]>;
    expect(body.meta?.total).toBe(14);
  });
});

describe('latestModernSlavery (the company lookup join)', () => {
  it('is null before the register loads and for a company with no statement there', async () => {
    expect(await latestModernSlavery(env, '12345678')).toBeNull();
    stubOrigins({ modernSlavery: modernSlaveryOrigin });
    await refreshD1Source(env, ukModernSlaveryStatementsSource);
    expect(await latestModernSlavery(env, '00000006')).toBeNull();
    expect(await latestModernSlavery(env, '2345678')).toBeNull(); // a substring is not the company
    expect(await latestModernSlavery(env, '')).toBeNull();
  });

  it("prefers the company's own statement of the latest year, and lists its years", async () => {
    stubOrigins({ modernSlavery: modernSlaveryOrigin });
    await refreshD1Source(env, ukModernSlaveryStatementsSource);
    expect(await latestModernSlavery(env, '12345678')).toEqual({
      statement_year: THIS,
      period_start: '2025-01-01',
      period_end: '2025-12-31',
      group_submission: false,
      parent_name: null,
      turnover_band: '£36 million to £60 million',
      sectors: 'Manufacturing; Transportation, logistics, and storage',
      years_producing_statements: '1 to 5 years',
      includes: {
        org_structure: true,
        policies: true,
        risk_assessment: true,
        due_diligence: true,
        training: false,
        goals: false,
      },
      statement_url: 'https://widgets.example/modern-slavery',
      registry_pdf_url: `${PDF}AAAA1111/${THIS}/widgets.pdf`,
      statement_years: [LAST, THIS],
    });
    expect((await latestModernSlavery(env, '87654321'))?.group_submission).toBe(true);
  });
});

describe('GET /v1/data/uk-gender-pay-gap', () => {
  it('reads both reporting years, keeps the figures, never the person or the address', async () => {
    stubOrigins({ genderPayGap: genderPayGapOrigin });
    await refreshD1Source(env, ukGenderPayGapSource);
    const res = await authedFetch(GPG_URL);
    const text = await res.text();
    for (const banned of ['Jane Doe', 'Mill Lane', 'LS1 1AA', 'widgets.example', 'NO ID']) {
      expect(text).not.toContain(banned);
    }
    const body = JSON.parse(text) as SuccessEnvelope<UkGenderPayGapRecord[]>;
    expect(body.data).toHaveLength(3);
    expect(body.data.find((r) => r.employer_id === 501 && r.reporting_year === NEWER)).toEqual({
      employer_id: 501,
      reporting_year: NEWER,
      reporting_period: reportingPeriod(NEWER),
      employer: 'EXAMPLE WIDGETS LIMITED',
      company_number: '12345678',
      sic_codes: '1, 25990',
      mean_hourly_pct: 11.5,
      median_hourly_pct: -2.3,
      mean_bonus_pct: 30,
      median_bonus_pct: null,
      male_bonus_pct: 12.5,
      female_bonus_pct: 10,
      male_lower_quartile_pct: 48.3,
      female_lower_quartile_pct: 51.7,
      male_lower_middle_quartile_pct: null,
      female_lower_middle_quartile_pct: null,
      male_upper_middle_quartile_pct: null,
      female_upper_middle_quartile_pct: null,
      male_top_quartile_pct: 53,
      female_top_quartile_pct: 47,
      employer_size: '250 to 499',
      submitted_late: true,
      due_date: `${NEWER + 1}-04-05`,
      submitted_on: `${NEWER + 1}-04-20`,
    });
    expect((await lastLog('uk-gender-pay-gap'))?.message).toMatch(/^append \+3 ~0/);
  });

  it('filters by company number, year, lateness and gap thresholds', async () => {
    stubOrigins({ genderPayGap: genderPayGapOrigin });
    await refreshD1Source(env, ukGenderPayGapSource);
    const { key } = await issueKey();
    const ids = async (qs: string): Promise<string[]> => {
      const body = (await (await authedFetch(`${GPG_URL}?${qs}`, key)).json()) as SuccessEnvelope<
        UkGenderPayGapRecord[]
      >;
      return body.data.map((r) => `${r.employer_id}/${r.reporting_year}`).sort();
    };
    expect(await ids('company_number=12345678')).toEqual([`501/${OLDER}`, `501/${NEWER}`]);
    expect(await ids(`reporting_year=${NEWER}`)).toEqual([`501/${NEWER}`, `777/${NEWER}`]);
    expect(await ids('submitted_late=true')).toEqual([`501/${NEWER}`]);
    expect(await ids('mean_hourly_pct_min=12')).toEqual([`501/${OLDER}`]);
    expect(await ids('median_hourly_pct_max=0')).toEqual([`501/${NEWER}`, `777/${NEWER}`]);
    expect(await ids('employer=fire')).toEqual([`777/${NEWER}`]);
  });

  it('skips a newest year that is not published yet, and falls back to fixtures on a dead origin', async () => {
    stubOrigins({
      genderPayGap: (year) =>
        year === OLDER ? chunked(GPG_OLDER) : new Response('Not Found', { status: 404 }),
    });
    await refreshD1Source(env, ukGenderPayGapSource);
    expect((await lastLog('uk-gender-pay-gap'))?.message).toMatch(/^append \+1 ~0/);
    stubOrigins({ genderPayGap: () => new Response('nope', { status: 503 }) });
    await refreshD1Source(env, ukGenderPayGapSource);
    const body = (await (await authedFetch(GPG_URL)).json()) as SuccessEnvelope<unknown[]>;
    expect(body.meta?.total).toBe(1 + 13);
  });
});

describe('latestGenderPayGap (the company lookup join)', () => {
  it('is null before the register loads, then the latest year with the report count', async () => {
    expect(await latestGenderPayGap(env, '12345678')).toBeNull();
    stubOrigins({ genderPayGap: genderPayGapOrigin });
    await refreshD1Source(env, ukGenderPayGapSource);
    expect(await latestGenderPayGap(env, '12345678')).toEqual({
      reporting_year: NEWER,
      reporting_period: reportingPeriod(NEWER),
      mean_hourly_pct: 11.5,
      median_hourly_pct: -2.3,
      mean_bonus_pct: 30,
      median_bonus_pct: null,
      employer_size: '250 to 499',
      submitted_late: true,
      submitted_on: `${NEWER + 1}-04-20`,
      reports: 2,
    });
    expect(await latestGenderPayGap(env, '00000006')).toBeNull();
    expect(await latestGenderPayGap(env, '2345678')).toBeNull();
  });
});
