import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/nhs-ods.json';
import type { DataSource } from './types';
import { byteCapTransform } from './zip';
import { originFetch } from './origin';

// NHS organisation register — the Organisation Data Service (ODS) run by NHS
// England: GP practices, NHS trusts and their sites, pharmacies, dental
// practices and independent-sector healthcare providers, each keyed by its
// ODS code (NICHE-RESEARCH-2026-09-B §2). OGL v3; no key, no account.
//
// Ingest: ODS republishes one header-less CSV per organisation type every
// night from the ODS Data Search and Export service
// (`…/api/getReport?report=<file>`, verified 2026-09-24; the older
// files.digital.nhs.uk/assets/ods/current/<file>.zip path now returns 403 for
// the current files). All the files we read share ODS's standard 27-column organisation layout,
// so a single positional parser covers them; each file tags its rows with
// the organisation type. Every file is required — a missing or reshaped file
// fails the load loudly (the previous generation keeps serving) rather than
// silently dropping a whole organisation type into the change feed.
//
// Data posture (Blind Mode): organisation-level only. The contact telephone
// column (27-column layout, field 18) is DROPPED at ingest, and the
// practitioner files ODS also publishes (egpcur, egdpcur, epracmem — named
// GPs and dentists) are never fetched.

const FILE_BASE = 'https://www.odsdatasearchandexport.nhs.uk/api/getReport?report=';
const FILE_HOST = /(^|\.)odsdatasearchandexport\.nhs\.uk$/;
const USER_AGENT = 'gankdat.com data refresh';
/** Per-file byte cap; the largest (trust sites, pharmacies) are single-digit MB. */
const MAX_BYTES = 64 * 1024 * 1024;
/** Standard ODS organisation layout: fields 1–18 are the ones we read. */
const MIN_COLUMNS = 18;

/** ODS files ingested, in load order, and the organisation type each one carries. */
export const ODS_FILES: readonly { file: string; orgType: string }[] = [
  { file: 'etr', orgType: 'NHS trust' },
  { file: 'ets', orgType: 'NHS trust site' },
  { file: 'epraccur', orgType: 'GP practice' },
  { file: 'edispensary', orgType: 'Pharmacy' },
  { file: 'egdpprac', orgType: 'Dental practice' },
  { file: 'ephp', orgType: 'Independent healthcare provider' },
];

export const nhsOdsRecordSchema = z.object({
  /** ODS organisation code, e.g. "RJ1" (trust) or "A81001" (GP practice) — stable. */
  ods_code: z.string(),
  name: z.string(),
  /** "GP practice", "NHS trust", "NHS trust site", "Pharmacy", "Dental practice", "Independent healthcare provider". */
  org_type: z.string(),
  /** "Active", "Closed", "Dormant" or "Proposed" (from the status code, or the close date for files without one). */
  status: z.string(),
  /** ODS national grouping code (NHS England region), e.g. "Y56". */
  national_grouping: z.string().nullable(),
  /** ODS high-level health geography code (integrated care board), e.g. "QWE". */
  health_geography: z.string().nullable(),
  address: z.string().nullable(),
  town: z.string().nullable(),
  county: z.string().nullable(),
  postcode: z.string().nullable(),
  outward_code: z.string().nullable(),
  open_date: z.string().nullable(),
  close_date: z.string().nullable(),
  /** ODS organisation sub-type code as published (file-specific; null where the file has none). */
  sub_type: z.string().nullable(),
  /** Parent organisation code: the commissioning sub-ICB location for practices and pharmacies, the trust for a trust site. */
  parent_code: z.string().nullable(),
  parent_joined: z.string().nullable(),
  parent_left: z.string().nullable(),
  /** GP practices only: the prescribing setting, e.g. "GP practice", "Out-of-hours practice", "Prison". */
  prescribing_setting: z.string().nullable(),
  /** The organisation's record in the ODS ORD API. */
  ord_url: z.string(),
});

export type NhsOdsRecord = z.infer<typeof nhsOdsRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/** ODS dates are YYYYMMDD; also accepts YYYY-MM-DD; else null. */
function isoDate(raw: string | null): string | null {
  if (raw === null) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return iso ? iso[1]! : null;
}

function outwardCode(postcode: string | null): string | null {
  if (postcode === null) return null;
  const compact = postcode.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) return null;
  return compact.slice(0, -3);
}

const STATUS: Record<string, string> = {
  A: 'Active',
  C: 'Closed',
  D: 'Dormant',
  P: 'Proposed',
};

// epraccur field 26 (prescribing setting), per the ODS epraccur specification.
const PRESCRIBING_SETTING: Record<string, string> = {
  '0': 'Other',
  '1': 'Walk-in centre practice',
  '2': 'Out-of-hours practice',
  '3': 'Walk-in centre and out-of-hours practice',
  '4': 'GP practice',
  '8': 'Public health service',
  '9': 'Community health service',
  '10': 'Hospital service',
  '11': 'Optometry service',
  '12': 'Urgent and emergency care',
  '13': 'Hospice',
  '14': 'Care home or nursing home',
  '15': 'Border Force',
  '16': 'Young offender institution',
  '17': 'Secure training centre',
  '18': "Secure children's home",
  '19': 'Immigration removal centre',
  '20': 'Court',
  '21': 'Police custody',
  '22': 'Sexual assault referral centre',
  '24': 'Other justice estate',
  '25': 'Prison',
};

/** Positions in the standard ODS organisation CSV (0-based; field 18, the telephone, is never read). */
const POS = {
  code: 0,
  name: 1,
  nationalGrouping: 2,
  healthGeography: 3,
  address1: 4,
  address2: 5,
  address3: 6,
  address4: 7,
  address5: 8,
  postcode: 9,
  openDate: 10,
  closeDate: 11,
  status: 12,
  subType: 13,
  parent: 14,
  parentJoined: 15,
  parentLeft: 16,
  prescribingSetting: 25,
} as const;

function statusOf(raw: string | null, closeDate: string | null): string {
  if (raw !== null) {
    const mapped = STATUS[raw.toUpperCase()];
    if (mapped) return mapped;
  }
  // Trust and site files carry no status column: closed when a close date has passed.
  return closeDate !== null && closeDate <= new Date().toISOString().slice(0, 10)
    ? 'Closed'
    : 'Active';
}

export function normalizeRow(cols: string[], orgType: string): NhsOdsRecord | null {
  const at = (pos: number): string | null => clean(cols[pos]);
  const code = at(POS.code)?.toUpperCase() ?? null;
  const name = at(POS.name);
  if (code === null || name === null || !/^[A-Z0-9]{3,12}$/.test(code)) return null;
  const postcode = at(POS.postcode);
  const closeDate = isoDate(at(POS.closeDate));
  const address = [at(POS.address1), at(POS.address2), at(POS.address3)]
    .filter((part): part is string => part !== null)
    .join(', ');
  const setting = orgType === 'GP practice' ? at(POS.prescribingSetting) : null;
  return {
    ods_code: code,
    name,
    org_type: orgType,
    status: statusOf(at(POS.status), closeDate),
    national_grouping: at(POS.nationalGrouping),
    health_geography: at(POS.healthGeography),
    address: address === '' ? null : address,
    town: at(POS.address4),
    county: at(POS.address5),
    postcode,
    outward_code: outwardCode(postcode),
    open_date: isoDate(at(POS.openDate)),
    close_date: closeDate,
    sub_type: at(POS.subType),
    parent_code: at(POS.parent)?.toUpperCase() ?? null,
    parent_joined: isoDate(at(POS.parentJoined)),
    parent_left: isoDate(at(POS.parentLeft)),
    prescribing_setting: setting === null ? null : (PRESCRIBING_SETTING[setting] ?? setting),
    ord_url: `https://directory.spineservices.nhs.uk/ORD/2-0-0/organisations/${code}`,
  };
}

async function fetchFile(file: string): Promise<Response> {
  const url = new URL(`${FILE_BASE}${file}`);
  if (url.protocol !== 'https:' || !FILE_HOST.test(url.hostname)) {
    throw new Error(`ODS file on unexpected host (${url.hostname})`);
  }
  let res = await originFetch(url.toString(), { headers: { 'user-agent': USER_AGENT } });
  for (let attempt = 1; res.status >= 500 && attempt <= 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, 20_000 * attempt));
    res = await originFetch(url.toString(), { headers: { 'user-agent': USER_AGENT } });
  }
  if (!res.ok || !res.body) throw new Error(`ODS ${file} download failed: ${res.status}`);
  return res;
}

async function* streamFile(file: string, orgType: string): AsyncGenerator<NhsOdsRecord> {
  const res = await fetchFile(file);
  let rows = 0;
  let yielded = 0;
  for await (const row of csvRows(res.body!.pipeThrough(byteCapTransform(MAX_BYTES)))) {
    if (row.length === 1 && (row[0] ?? '').trim() === '') continue; // trailing blank line
    rows += 1;
    if (row.length < MIN_COLUMNS) {
      throw new Error(
        `ODS ${file} format changed — row ${rows} has ${row.length} columns, expected ≥ ${MIN_COLUMNS}`,
      );
    }
    const record = normalizeRow(row, orgType);
    if (record) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error(`ODS ${file} parsed 0 records`);
}

async function* streamFromOrigin(): AsyncGenerator<NhsOdsRecord> {
  // ODS codes are unique across the register; the guard only protects the
  // generation from a code that shows up in two files.
  const seen = new Set<string>();
  for (const { file, orgType } of ODS_FILES) {
    for await (const record of streamFile(file, orgType)) {
      if (seen.has(record.ods_code)) continue;
      seen.add(record.ods_code);
      yield record;
    }
  }
}

function fixtures(): NhsOdsRecord[] {
  return z.array(nhsOdsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<NhsOdsRecord> {
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
          source: 'nhs-ods',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const nhsOdsSource: DataSource<NhsOdsRecord> = {
  slug: 'nhs-ods',
  title: 'NHS organisations in England (ODS register)',
  description:
    'Every GP practice, NHS trust and trust site, pharmacy, dental practice and independent-sector healthcare provider on the NHS Organisation Data Service register for England — ODS code, name, organisation type, active/closed status, NHS England region and integrated care board codes, address and postcode, open and close dates, parent organisation (commissioner or trust) and, for GP practices, the prescribing setting. From the official nightly ODS extracts, keyed by the stable ODS code. Telephone numbers are dropped at ingest; the practitioner files (named GPs and dentists) are never ingested.',
  storage: 'd1',
  stats: {
    date: { field: 'open_date', title: 'Organisations opened by month' },
    groupBy: [
      { field: 'org_type', title: 'By organisation type', limit: 8 },
      { field: 'status', title: 'By status', limit: 4 },
      { field: 'national_grouping', title: 'By NHS England region code', limit: 10 },
      { field: 'health_geography', title: 'Largest integrated care boards (code)', limit: 15 },
    ],
  },
  recordSchema: nhsOdsRecordSchema,
  queryParams: z.object({
    ods_code: z.string().optional(),
    name: z.string().optional(),
    org_type: z.string().optional(),
    status: z.string().optional(),
    national_grouping: z.string().optional(),
    health_geography: z.string().optional(),
    town: z.string().optional(),
    postcode: z.string().optional(),
    outward_code: z.string().optional(),
    parent_code: z.string().optional(),
    prescribing_setting: z.string().optional(),
    open_date_after: z.iso.date().optional(),
    open_date_before: z.iso.date().optional(),
    close_date_after: z.iso.date().optional(),
    close_date_before: z.iso.date().optional(),
  }),
  refresh: { cron: '55 5 * * *', cacheTtlSeconds: 86_400, wave: 6 },
  idOf: (r) => r.ods_code,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<NhsOdsRecord[]> {
    const records: NhsOdsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
