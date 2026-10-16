import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/uk-gambling-operators.json';
import type { DataSource } from './types';
import { byteCapTransform } from './zip';
import { originFetch } from './origin';

// Gambling Commission licence register — every operating licence held by a
// gambling business in Great Britain (remote and non-remote betting, casino,
// bingo, gaming machines, lotteries, gambling software), the trading names and
// website domains registered against each operator, and every licensed
// premises (betting shops, casinos, bingo halls, arcades). Exchange 2026-W39
// runner-up: KYB and payments teams, affiliate-compliance checks ("is this
// domain licensed?") and sector suppliers. OGL v3 — the data.gov.uk record
// "Operator licence register" carries the licence (confirmed 2026-09-24); no
// key, no account.
//
// Ingest: five daily CSVs under gamblingcommission.gov.uk/downloads/ (headers
// recorded 2026-09-24, values double-quoted, blank dates empty). Three record
// kinds share one table, told apart by `record_type`:
//   licence  — one row per licence number (the licences file lists one row per
//              licence × activity; activities are joined "|"), enriched with the
//              operator's active trading names
//   domain   — one row per (operator, domain name) with its status
//   premises — one row per licensed premises (activity, local authority, address)
// Every file is required — a missing or reshaped file fails the load loudly
// (the previous generation keeps serving) rather than silently dropping a
// record kind into the change feed.
//
// Data posture: organisation-level statutory register. Operator and trading
// names are the licensed business names as published; the personal licence
// registers (management and functional licences held by individuals) are never
// fetched. Premises addresses are business premises.

const FILE_BASE = 'https://www.gamblingcommission.gov.uk/downloads/';
const FILE_HOST = /(^|\.)gamblingcommission\.gov\.uk$/;
const USER_AGENT = 'Mozilla/5.0 (compatible; gankdat.com data refresh)';
/** Per-file byte cap; the largest file (licences) is ~0.5 MB. */
const MAX_BYTES = 32 * 1024 * 1024;
/** Per-file fetch timeout — these files are small; a hang must not eat the wave. */
const FETCH_TIMEOUT_MS = 90_000;
/** Trading names joined onto a licence row are capped so one operator cannot bloat a row. */
const MAX_TRADING_NAMES = 50;

export const REGISTER_FILES = {
  businesses: 'business-licence-register-businesses.csv',
  licences: 'business-licence-register-licences.csv',
  tradingNames: 'business-licence-register-trading-names.csv',
  domainNames: 'business-licence-register-domain-names.csv',
  premises: 'premises-licence-register.csv',
} as const;

/** Load order (each file is required). */
export const FILE_ORDER: readonly (keyof typeof REGISTER_FILES)[] = [
  'businesses',
  'tradingNames',
  'licences',
  'domainNames',
  'premises',
];

const COL = {
  account: 'Account Number',
  accountName: 'Licence Account Name',
  licenceNumber: 'Licence Number',
  status: 'Status',
  type: 'Type',
  activity: 'Activity',
  startDate: 'Start Date',
  endDate: 'End Date',
  tradingName: 'Trading Name',
  domainName: 'Domain Name',
  premisesAccountName: 'Account Name',
  premisesActivity: 'Premises Activity',
  localAuthority: 'Local Authority',
  address1: 'Address Line 1',
  address2: 'Address Line 2',
  city: 'City',
  postcode: 'Postcode',
} as const;

const REQUIRED_COLUMNS: Record<keyof typeof REGISTER_FILES, readonly string[]> = {
  businesses: [COL.account, COL.accountName],
  licences: [COL.account, COL.licenceNumber, COL.status, COL.type, COL.activity],
  tradingNames: [COL.account, COL.tradingName],
  domainNames: [COL.account, COL.domainName],
  premises: [COL.account, COL.premisesActivity, COL.localAuthority, COL.postcode],
};

export const ukGamblingOperatorsRecordSchema = z.object({
  /** Stable id: "licence:<licence number>", "domain:<account>:<domain>" or "premises:<account>:<activity>:<address>:<postcode>". */
  id: z.string(),
  /** "licence", "domain" or "premises". */
  record_type: z.string(),
  /** Gambling Commission account number of the operator (shared by all its rows). */
  account_number: z.string(),
  /** Licence account name — the licensed business as published. */
  operator_name: z.string(),
  /** Licence rows: the operating licence number, e.g. "000-039022-R-319313-011". */
  licence_number: z.string().nullable(),
  /** Licence and domain rows: status as published (Active, Surrendered, Revoked, Lapsed, …). */
  status: z.string().nullable(),
  /** true when the status is Active (or the row has no status, as premises rows); filter on this rather than a substring of `status`, which "Inactive" also matches. */
  is_active: z.boolean(),
  /** Licence rows: "Remote", "Non-Remote" or "Ancillary Remote" as published. */
  licence_type: z.string().nullable(),
  /** Licence rows: licensed activities joined "|"; premises rows: the premises activity (Betting, Bingo, Casino, Adult Gaming Centre, …). */
  activities: z.string().nullable(),
  /** Licence rows: licence start date (YYYY-MM-DD). */
  start_date: z.string().nullable(),
  /** Licence rows: licence end date (YYYY-MM-DD) where the licence has ended. */
  end_date: z.string().nullable(),
  /** Licence rows: the operator's active trading names joined "|". */
  trading_names: z.string().nullable(),
  /** Domain rows: the website domain registered against the operator. */
  domain_name: z.string().nullable(),
  /** Premises rows: licensing authority (the local council). */
  local_authority: z.string().nullable(),
  /** Premises rows: business premises address. */
  address: z.string().nullable(),
  city: z.string().nullable(),
  postcode: z.string().nullable(),
  outward_code: z.string().nullable(),
  /** The operator's entry on the Commission's public register. */
  register_url: z.string(),
});

export type UkGamblingOperatorsRecord = z.infer<typeof ukGamblingOperatorsRecordSchema>;

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

/**
 * The register's date format is not documented: accepts YYYY-MM-DD (with or
 * without a time), DD/MM/YYYY, DD-MM-YYYY, "DD Mon YYYY" and "DD-Mon-YYYY";
 * anything else → null.
 */
export function isoDate(raw: string | null): string | null {
  if (raw === null) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(raw);
  if (numeric) {
    return `${numeric[3]}-${numeric[2]!.padStart(2, '0')}-${numeric[1]!.padStart(2, '0')}`;
  }
  const named = /^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -](\d{4})/.exec(raw);
  if (named) {
    const month = MONTHS[named[2]!.toLowerCase()];
    return month ? `${named[3]}-${month}-${named[1]!.padStart(2, '0')}` : null;
  }
  return null;
}

function outwardCode(postcode: string | null): string | null {
  if (postcode === null) return null;
  const compact = postcode.replace(/\s+/g, '').toUpperCase();
  if (compact.length < 5 || compact.length > 7) return null;
  return compact.slice(0, -3);
}

function registerUrl(account: string): string {
  return `https://www.gamblingcommission.gov.uk/public-register/business/detail/${encodeURIComponent(account)}`;
}

/** Lower-cased, punctuation-free key segment for premises ids. */
function keyOf(value: string | null): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isActive(status: string | null): boolean {
  return status === null || status.toLowerCase() === 'active';
}

/** Zero-padding on account numbers is not stable across files: strip it (but keep a lone "0"). */
function accountKey(raw: string | null): string | null {
  if (raw === null) return null;
  const stripped = raw.replace(/^0+(?=\d)/, '');
  return stripped === '' ? null : stripped;
}

interface LicenceAccumulator {
  account: string;
  status: string | null;
  type: string | null;
  activities: Set<string>;
  startDate: string | null;
  endDate: string | null;
}

async function fetchFile(file: keyof typeof REGISTER_FILES): Promise<Response> {
  const url = new URL(`${FILE_BASE}${REGISTER_FILES[file]}`);
  if (url.protocol !== 'https:' || !FILE_HOST.test(url.hostname)) {
    throw new Error(`Gambling Commission file on unexpected host (${url.hostname})`);
  }
  const get = (): Promise<Response> =>
    originFetch(url.toString(), {
      headers: { 'user-agent': USER_AGENT, accept: 'text/csv,*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  let res = await get();
  for (let attempt = 1; res.status >= 500 && attempt <= 2; attempt += 1) {
    await new Promise((r) => setTimeout(r, 15_000 * attempt));
    res = await get();
  }
  if (!res.ok || !res.body) {
    throw new Error(`Gambling Commission ${REGISTER_FILES[file]} download failed: ${res.status}`);
  }
  return res;
}

/** Streams a register file's data rows as column-name → value maps, validating the header. */
async function* fileRows(
  file: keyof typeof REGISTER_FILES,
): AsyncGenerator<(name: string) => string | null> {
  const res = await fetchFile(file);
  let idx: Map<string, number> | null = null;
  let rows = 0;
  for await (const row of csvRows(res.body!.pipeThrough(byteCapTransform(MAX_BYTES)))) {
    if (idx === null) {
      idx = new Map(
        row.map((column, i) => [
          column
            .replace(/^\uFEFF/, '')
            .trim()
            .toLowerCase(),
          i,
        ]),
      );
      const missing = REQUIRED_COLUMNS[file].filter((column) => !idx!.has(column.toLowerCase()));
      if (missing.length > 0) {
        throw new Error(
          `Gambling Commission ${REGISTER_FILES[file]} format changed — missing: ${missing.join(', ')}`,
        );
      }
      continue;
    }
    if (row.length === 1 && (row[0] ?? '').trim() === '') continue; // trailing blank line
    rows += 1;
    const cols = row;
    const index = idx;
    yield (name: string): string | null => clean(cols[index.get(name.toLowerCase()) ?? -1]);
  }
  if (rows === 0) throw new Error(`Gambling Commission ${REGISTER_FILES[file]} parsed 0 rows`);
}

function blank(): Omit<
  UkGamblingOperatorsRecord,
  'id' | 'record_type' | 'account_number' | 'operator_name' | 'register_url'
> {
  return {
    licence_number: null,
    status: null,
    is_active: true,
    licence_type: null,
    activities: null,
    start_date: null,
    end_date: null,
    trading_names: null,
    domain_name: null,
    local_authority: null,
    address: null,
    city: null,
    postcode: null,
    outward_code: null,
  };
}

async function* streamFromOrigin(): AsyncGenerator<UkGamblingOperatorsRecord> {
  // 1. Operators: account number → licence account name.
  const operators = new Map<string, string>();
  for await (const col of fileRows('businesses')) {
    const account = accountKey(col(COL.account));
    const name = col(COL.accountName);
    if (account !== null && name !== null && !operators.has(account)) operators.set(account, name);
  }
  if (operators.size === 0) throw new Error('Gambling Commission businesses file has no operators');
  const nameOf = (account: string, fallback: string | null): string | null =>
    operators.get(account) ?? fallback;

  // 2. Active trading names per operator (joined onto licence rows).
  const tradingNames = new Map<string, string[]>();
  for await (const col of fileRows('tradingNames')) {
    const account = accountKey(col(COL.account));
    const name = col(COL.tradingName);
    if (account === null || name === null || !isActive(col(COL.status))) continue;
    const list = tradingNames.get(account) ?? [];
    if (list.length < MAX_TRADING_NAMES && !list.includes(name)) list.push(name);
    tradingNames.set(account, list);
  }

  // 3. Licences: one row per licence × activity in the file → one record per licence.
  const licences = new Map<string, LicenceAccumulator>();
  for await (const col of fileRows('licences')) {
    const account = accountKey(col(COL.account));
    const number = col(COL.licenceNumber);
    if (account === null || number === null) continue;
    const acc = licences.get(number) ?? {
      account,
      status: null,
      type: null,
      activities: new Set<string>(),
      startDate: null,
      endDate: null,
    };
    acc.status ??= col(COL.status);
    acc.type ??= col(COL.type);
    const activity = col(COL.activity);
    if (activity !== null) acc.activities.add(activity);
    acc.startDate ??= isoDate(col(COL.startDate));
    acc.endDate ??= isoDate(col(COL.endDate));
    licences.set(number, acc);
  }
  if (licences.size === 0) throw new Error('Gambling Commission licences file has no licences');
  for (const [number, acc] of licences) {
    const operator = nameOf(acc.account, null);
    if (operator === null) continue; // a licence whose operator is not on the businesses file
    const names = tradingNames.get(acc.account) ?? [];
    yield {
      ...blank(),
      id: `licence:${number}`,
      record_type: 'licence',
      account_number: acc.account,
      operator_name: operator,
      licence_number: number,
      status: acc.status,
      is_active: isActive(acc.status),
      licence_type: acc.type,
      activities: acc.activities.size > 0 ? [...acc.activities].sort().join('|') : null,
      start_date: acc.startDate,
      end_date: acc.endDate,
      trading_names: names.length > 0 ? names.join('|') : null,
      register_url: registerUrl(acc.account),
    };
  }

  // 4. Domain names: one record per (operator, domain).
  const seen = new Set<string>();
  for await (const col of fileRows('domainNames')) {
    const account = accountKey(col(COL.account));
    const domain = col(COL.domainName)?.toLowerCase() ?? null;
    if (account === null || domain === null) continue;
    const operator = nameOf(account, null);
    if (operator === null) continue;
    const id = `domain:${account}:${domain}`;
    if (seen.has(id)) continue;
    seen.add(id);
    yield {
      ...blank(),
      id,
      record_type: 'domain',
      account_number: account,
      operator_name: operator,
      status: col(COL.status),
      is_active: isActive(col(COL.status)),
      domain_name: domain,
      register_url: registerUrl(account),
    };
  }

  // 5. Premises: one record per licensed premises.
  for await (const col of fileRows('premises')) {
    const account = accountKey(col(COL.account));
    if (account === null) continue;
    const operator = nameOf(account, col(COL.premisesAccountName));
    if (operator === null) continue;
    const activity = col(COL.premisesActivity);
    const address1 = col(COL.address1);
    const address2 = col(COL.address2);
    const postcode = col(COL.postcode);
    const id = `premises:${account}:${keyOf(activity)}:${keyOf(address1)}:${keyOf(postcode)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const address = [address1, address2].filter((part): part is string => part !== null).join(', ');
    yield {
      ...blank(),
      id,
      record_type: 'premises',
      account_number: account,
      operator_name: operator,
      activities: activity,
      local_authority: col(COL.localAuthority),
      address: address === '' ? null : address,
      city: col(COL.city),
      postcode,
      outward_code: outwardCode(postcode),
      register_url: registerUrl(account),
    };
  }
}

function fixtures(): UkGamblingOperatorsRecord[] {
  return z.array(ukGamblingOperatorsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkGamblingOperatorsRecord> {
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
          source: 'uk-gambling-operators',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukGamblingOperatorsSource: DataSource<UkGamblingOperatorsRecord> = {
  slug: 'uk-gambling-operators',
  title: 'Licensed gambling operators in Great Britain (Gambling Commission register)',
  description:
    "Every operating licence on the Gambling Commission register for Great Britain — remote and non-remote betting, casino, bingo, gaming-machine, lottery and gambling-software licences with status, activities, start and end dates and the operator's trading names — plus the website domains registered against each operator and every licensed premises (betting shops, casinos, bingo halls, arcades) with activity, licensing authority and address. One row per licence, domain or premises (record_type), keyed by the stable licence number or premises key. From the Commission's daily public register files; personal licences held by individuals are never ingested.",
  storage: 'd1',
  stats: {
    date: { field: 'start_date', title: 'Licences started by month' },
    groupBy: [
      { field: 'record_type', title: 'By record type', limit: 3 },
      { field: 'status', title: 'By status', limit: 8 },
      { field: 'licence_type', title: 'By licence type', limit: 4 },
      { field: 'activities', title: 'By activity', limit: 15 },
      { field: 'local_authority', title: 'Most licensed premises by authority', limit: 15 },
    ],
  },
  recordSchema: ukGamblingOperatorsRecordSchema,
  queryParams: z.object({
    /** licence, domain or premises. */
    record_type: z.string().optional(),
    account_number: z.string().optional(),
    operator_name: z.string().optional(),
    licence_number: z.string().optional(),
    status: z.string().optional(),
    /** true = Active licences and domains (and every premises row); false = surrendered, revoked, lapsed, inactive, … */
    is_active: z.stringbool().optional(),
    licence_type: z.string().optional(),
    activities: z.string().optional(),
    trading_names: z.string().optional(),
    domain_name: z.string().optional(),
    local_authority: z.string().optional(),
    city: z.string().optional(),
    postcode: z.string().optional(),
    outward_code: z.string().optional(),
    start_date_after: z.iso.date().optional(),
    start_date_before: z.iso.date().optional(),
    end_date_after: z.iso.date().optional(),
    end_date_before: z.iso.date().optional(),
  }),
  refresh: { cron: '15 5 * * *', cacheTtlSeconds: 86_400, wave: 2 },
  idOf: (r) => r.id,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkGamblingOperatorsRecord[]> {
    const records: UkGamblingOperatorsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
