import { z } from 'zod';
import { readD1ByIdPrefix, SourceNotLoadedError } from './d1store';
import fixtureRecords from './fixtures/uk-company-accounts.json';
import { originFetch } from './origin';
import type { DataSource } from './types';
import { inflateRaw, zipMembers } from './zip';

// UK company accounts — the headline figures of every set of accounts filed
// electronically at Companies House (≈ 60 % of the 2.2 million filed a year), read
// from the free "Accounts Data Product": one ZIP a day (Tuesday to Saturday) holding
// the previous day's filings as individual iXBRL documents. Spike
// `docs/exchange/spikes/uk-company-accounts-financials.md` (2026-11-12): OGL v3 and
// "no rules or requirements on how the information on the public register is used";
// four sellers price the series (Endole £39/user/mo, Company Check £35+VAT/mo,
// Creditsafe, Global Mindset £39/mo) and every standalone wrapper shows 0–2 users, so
// the value here is the join on the company number — `financials` on
// uk-company-profiles and the /diligence agent's ninth register — not a new audience.
//
// Origin (relay `ch-accounts-zip-2026-11-12`): `Accounts_Bulk_Data-<YYYY-MM-DD>.zip`,
// 58–100 MiB on a normal day (≈ 8,000–11,000 members, ≈ 7.7 KB each compressed, ≈ 70–
// 110 KB inflated), 208 MiB at a month end, 598 MiB on 1 October; every member is
// deflate with its sizes in the local header (no data descriptors) and the host
// honours Range on any byte. So the file is walked member by member in Range slices
// (`zip.ts zipMembers`) and a read stops at a byte/elapsed budget with the next
// header's offset kept in KV: a big day is a backlog the following waves finish, never
// a wall. Members are named `Prod223_4348_<company number>_<balance-sheet date>.html`,
// so the register's key is known before a byte is inflated. The 3 % that are old XBRL
// (`.xml`) or nested ZIPs are counted and skipped.
//
// Parsing is a regex pass, not a DOM: the dozen facts kept are `ix:nonFraction`
// elements whose `name` ends in a known tag, valued as sign × text × 10^scale with
// `format` deciding the separators, and dated by their `contextRef`'s instant or end
// date — the rules of the Department for Business and Trade's `stream-read-xbrl`
// (MIT). A balance-sheet fact counts only in a context with no dimension (the whole
// entity), creditors only in one whose every dimension says "within one year". Net
// assets fall back to total `Equity` (equal by the balance-sheet identity; micro-
// entity accounts tag only that) and say so in `net_assets_source`. On the 87 real
// members of the 11-11 file's first MiB: net assets 86, employees 83, cash 50,
// creditors 67, turnover 2, profit 6 — small companies file balance-sheet-only
// accounts, so turnover and profit are extras, never the promise.
//
// The register ACCUMULATES (`append`): a day's stream is that day's filings, upserted
// by company number + balance-sheet date; nothing is removed for being absent and a
// day without a file (Sunday, Monday) is an `ok` row with `append +0`.
//
// Blind Mode: organisation-level money and counts only. Director and signatory names,
// the narrative notes and every other `ix:nonNumeric` fact are never extracted.

const ORIGIN = 'https://download.companieshouse.gov.uk/';
const FILING_HISTORY = 'https://find-and-update.company-information.service.gov.uk/company/';
const USER_AGENT = 'gankdat.com data refresh';
export const ACCOUNTS_CURSOR_KEY = 'source:uk-company-accounts:cursor';
/** Days back (today included) a daily file is looked for; the host keeps 60. */
const WINDOW_DAYS = 7;
/** How long a file's state is remembered after its date — longer than the window. */
const REMEMBER_DAYS = 21;
/** A member inflating past this is not an accounts document worth a wave's memory. */
const MAX_MEMBER_BYTES = 32 * 1024 * 1024;

/** Budgets of one wave's read (cron limit 15 min wall, 5 min CPU); a test shrinks them. */
export const accountsBudget = {
  /** Stop opening members this long after the stream started. */
  elapsedMs: 8 * 60_000,
  /** Compressed bytes read per wave (≈ three normal days, or a month-end file and a bit). */
  bytes: 256 * 1024 * 1024,
  sliceBytes: 8 * 1024 * 1024,
  now: (): number => Date.now(),
};

export function accountsFileName(date: string): string {
  return `Accounts_Bulk_Data-${date}.zip`;
}

export const ukCompanyAccountsRecordSchema = z.object({
  /** Companies House number as the file name carries it (8 characters, zero-padded or prefixed). */
  company_number: z.string(),
  /** Registered name as tagged in the accounts; null when the filer did not tag one. */
  company: z.string().nullable(),
  /** The date the balance sheet is drawn up to (the period end). */
  balance_sheet_date: z.string(),
  period_start: z.string().nullable(),
  dormant: z.boolean().nullable(),
  /** Net assets (negative = net liabilities), in pounds. */
  net_assets: z.number().nullable(),
  /** The tag the figure was read from: the net-assets line itself, or total equity (equal by identity). */
  net_assets_source: z.enum(['NetAssetsLiabilities', 'Equity']).nullable(),
  cash: z.number().nullable(),
  creditors_within_one_year: z.number().nullable(),
  /** Average number of employees in the period, as tagged. */
  employees: z.number().nullable(),
  /** Turnover and profit are filed by few small companies; null is the norm. */
  turnover: z.number().nullable(),
  profit_loss: z.number().nullable(),
  /** The comparative period tagged in the same accounts. */
  prior_balance_sheet_date: z.string().nullable(),
  prior_net_assets: z.number().nullable(),
  prior_cash: z.number().nullable(),
  prior_creditors_within_one_year: z.number().nullable(),
  prior_employees: z.number().nullable(),
  prior_turnover: z.number().nullable(),
  prior_profit_loss: z.number().nullable(),
  /** Date of the daily bulk file that carried the filing (registered the working day before). */
  file_date: z.string(),
  filing_history_url: z.string(),
});

export type UkCompanyAccountsRecord = z.infer<typeof ukCompanyAccountsRecordSchema>;

// ── iXBRL reading ──────────────────────────────────────────────────────────────

interface Context {
  /** The instant, or the end date of a duration. */
  date: string | null;
  start: string | null;
  /** Local names of the context's dimension members; empty = the whole entity. */
  members: string[];
}

const CONTEXT_RE = /<((?:[\w-]+:)?)context\b([^>]*)>([\s\S]*?)<\/\1context>/g;
const FACT_RE = /<ix:nonFraction\b([^>]*)>([\s\S]*?)<\/ix:nonFraction>/g;
// Anchored on the two names wanted: `ix:nonNumeric` nests (a whole page section wraps the small
// facts inside it), so a generic open-to-first-close match would swallow the inner ones.
const TEXT_FACT_RE =
  /<ix:nonNumeric\b([^>]*\bname\s*=\s*["'][^"']*:(?:EntityDormantTruefalse|EntityCurrentLegalOrRegisteredName)["'][^>]*)>([\s\S]*?)<\/ix:nonNumeric>/g;
const MEMBER_RE = /<(?:[\w-]+:)?(?:explicitMember|typedMember)\b[^>]*>\s*([^<\s]*)/g;
const ATTRIBUTE_RES = new Map<string, RegExp>();

function attr(attrs: string, name: string): string | null {
  let re = ATTRIBUTE_RES.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    ATTRIBUTE_RES.set(name, re);
  }
  const m = re.exec(attrs);
  return m ? (m[1] ?? m[2] ?? null) : null;
}
/** `core:Equity` → `Equity`. */
function localName(qname: string | null): string {
  const s = qname ?? '';
  return s.slice(s.indexOf(':') + 1);
}
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
function textOf(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ''))
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}
const DATE_TAG = (tag: string): RegExp =>
  new RegExp(`<(?:[\\w-]+:)?${tag}>\\s*(\\d{4}-\\d{2}-\\d{2})`);
const INSTANT_RE = DATE_TAG('instant');
const START_RE = DATE_TAG('startDate');
const END_RE = DATE_TAG('endDate');

function parseContexts(html: string): Map<string, Context> {
  const out = new Map<string, Context>();
  for (const m of html.matchAll(CONTEXT_RE)) {
    const id = attr(m[2] ?? '', 'id');
    if (!id) continue;
    const body = m[3] ?? '';
    const instant = INSTANT_RE.exec(body)?.[1] ?? null;
    out.set(id, {
      date: instant ?? END_RE.exec(body)?.[1] ?? null,
      start: START_RE.exec(body)?.[1] ?? null,
      members: [...body.matchAll(MEMBER_RE)].map((x) => localName(x[1] ?? '')),
    });
  }
  return out;
}

const ZERO_FORMATS = /^(zerodash|fixed-zero|numdash)$/;
const EMPTY_FORMATS = /^(nocontent|fixed-empty)$/;
const COMMA_DECIMAL_FORMATS = /^(numdotcomma|numcommadecimal|numspacecomma|num-comma-decimal)$/;

/** sign × text × 10^scale, the separators read per `format`; null when the text is not a number. */
function numberOf(attrs: string, inner: string): number | null {
  const text = textOf(inner);
  const format = localName(attr(attrs, 'format'));
  let n: number;
  if (ZERO_FORMATS.test(format) || /^[-–—]$/.test(text)) {
    n = 0;
  } else if (text === '' || EMPTY_FORMATS.test(format)) {
    return null;
  } else {
    const digits = COMMA_DECIMAL_FORMATS.test(format)
      ? text.replace(/[.\s']/g, '').replace(',', '.')
      : text.replace(/[,\s']/g, '');
    // A negative is the `sign` attribute; brackets around the text are presentation only.
    const m = /^\(?(\d+(?:\.\d+)?)\)?$/.exec(digits);
    if (!m) return null;
    n = Number(m[1]);
  }
  const scale = Number(attr(attrs, 'scale') ?? '0');
  if (Number.isFinite(scale) && scale !== 0) n *= 10 ** scale;
  if (attr(attrs, 'sign') === '-') n = -n;
  return Math.round(n * 100) / 100 + 0; // pence at most; +0 turns -0 into 0
}

type Family = 'net_assets' | 'equity' | 'cash' | 'creditors' | 'employees' | 'turnover' | 'profit';
/** Tag → family and rank (a lower rank wins when a filing carries both). */
const WANTED = new Map<string, { family: Family; rank: number; dimensioned?: boolean }>([
  ['NetAssetsLiabilitiesIncludingPensionAssetLiability', { family: 'net_assets', rank: 0 }],
  ['NetAssetsLiabilities', { family: 'net_assets', rank: 1 }],
  ['Equity', { family: 'equity', rank: 0 }],
  ['CashBankInHand', { family: 'cash', rank: 0 }],
  ['CashBankOnHand', { family: 'cash', rank: 1 }],
  // FRS 102 taxonomies: one `Creditors` tag, the maturity in the context's dimensions.
  ['Creditors', { family: 'creditors', rank: 0, dimensioned: true }],
  // The older UK GAAP taxonomy's own tag, on the whole-entity context.
  ['CreditorsDueWithinOneYear', { family: 'creditors', rank: 1 }],
  ['AverageNumberEmployeesDuringPeriod', { family: 'employees', rank: 0 }],
  ['EmployeesTotal', { family: 'employees', rank: 1 }],
  ['TurnoverRevenue', { family: 'turnover', rank: 0 }],
  ['TurnoverGrossOperatingRevenue', { family: 'turnover', rank: 1 }],
  ['ProfitLoss', { family: 'profit', rank: 0 }],
  ['ProfitLossForPeriod', { family: 'profit', rank: 1 }],
]);
const WITHIN_ONE_YEAR = /^(WithinOneYear|CurrentFinancialInstruments)$/;

interface Picked {
  value: number | null;
  prior: number | null;
  priorDate: string | null;
  start: string | null;
}
const NOTHING: Picked = { value: null, prior: null, priorDate: null, start: null };

/** The figures of one accounts document, before the file name's key is attached. */
export type AccountsFigures = Omit<
  UkCompanyAccountsRecord,
  'company_number' | 'balance_sheet_date' | 'file_date' | 'filing_history_url'
>;

/**
 * Reads one iXBRL accounts document. `balanceSheetDate` (from the member's name) selects the
 * current period: a fact dated otherwise is the comparative, and the latest earlier date is
 * reported as the prior period.
 */
export function parseAccounts(html: string, balanceSheetDate: string): AccountsFigures {
  const contexts = parseContexts(html);
  const found = new Map<
    Family,
    Map<string, { rank: number; value: number; start: string | null }>
  >();
  for (const m of html.matchAll(FACT_RE)) {
    const attrs = m[1] ?? '';
    const want = WANTED.get(localName(attr(attrs, 'name')));
    if (!want) continue;
    const context = contexts.get(attr(attrs, 'contextRef') ?? '');
    if (!context?.date) continue;
    const whole = context.members.length === 0;
    const withinYear =
      context.members.length > 0 && context.members.every((x) => WITHIN_ONE_YEAR.test(x));
    if (want.dimensioned ? !withinYear : !whole) continue;
    const value = numberOf(attrs, m[2] ?? '');
    if (value === null) continue;
    let byDate = found.get(want.family);
    if (!byDate) {
      byDate = new Map();
      found.set(want.family, byDate);
    }
    const had = byDate.get(context.date);
    if (!had || want.rank < had.rank) {
      byDate.set(context.date, { rank: want.rank, value, start: context.start });
    }
  }
  const pick = (family: Family): Picked => {
    const byDate = found.get(family);
    const current = byDate?.get(balanceSheetDate);
    if (!byDate || !current) return NOTHING;
    const priorDate =
      [...byDate.keys()]
        .filter((d) => d < balanceSheetDate)
        .sort()
        .pop() ?? null;
    return {
      value: current.value,
      prior: priorDate ? (byDate.get(priorDate)?.value ?? null) : null,
      priorDate,
      start: current.start,
    };
  };

  let dormant: boolean | null = null;
  let company: string | null = null;
  for (const m of html.matchAll(TEXT_FACT_RE)) {
    const name = localName(attr(m[1] ?? '', 'name'));
    if (name === 'EntityDormantTruefalse' && dormant === null) {
      const text = textOf(m[2] ?? '').toLowerCase();
      const format = localName(attr(m[1] ?? '', 'format'));
      dormant =
        text === 'true' || /^(booleantrue|fixed-true)$/.test(format)
          ? true
          : text === 'false' || /^(booleanfalse|fixed-false)$/.test(format)
            ? false
            : null;
    } else if (name === 'EntityCurrentLegalOrRegisteredName' && company === null) {
      company = textOf(m[2] ?? '') || null;
    }
  }

  const netAssets = pick('net_assets');
  const equity = netAssets.value === null ? pick('equity') : NOTHING;
  const assets = netAssets.value !== null ? netAssets : equity;
  const cash = pick('cash');
  const creditors = pick('creditors');
  const employees = pick('employees');
  const turnover = pick('turnover');
  const profit = pick('profit');
  // Employee counts are read as absolute values: some filers attach a negative sign (DBT's rule).
  const abs = (n: number | null): number | null => (n === null ? null : Math.abs(n));
  return {
    company,
    period_start: employees.start ?? turnover.start ?? profit.start,
    dormant,
    net_assets: assets.value,
    net_assets_source:
      netAssets.value !== null ? 'NetAssetsLiabilities' : equity.value !== null ? 'Equity' : null,
    cash: cash.value,
    creditors_within_one_year: creditors.value,
    employees: abs(employees.value),
    turnover: turnover.value,
    profit_loss: profit.value,
    prior_balance_sheet_date:
      assets.priorDate ?? cash.priorDate ?? creditors.priorDate ?? employees.priorDate,
    prior_net_assets: assets.prior,
    prior_cash: cash.prior,
    prior_creditors_within_one_year: creditors.prior,
    prior_employees: abs(employees.prior),
    prior_turnover: turnover.prior,
    prior_profit_loss: profit.prior,
  };
}

const MEMBER_NAME_RE = /_([A-Z0-9]{8})_(\d{4})(\d{2})(\d{2})\.([a-z]+)$/i;

/** `Prod223_4348_00056710_20260430.html` → number, balance-sheet date, extension; null for anything else. */
export function memberKey(name: string): { number: string; date: string; ext: string } | null {
  const m = MEMBER_NAME_RE.exec(name);
  if (!m) return null;
  return {
    number: (m[1] ?? '').toUpperCase(),
    date: `${m[2]}-${m[3]}-${m[4]}`,
    ext: (m[5] ?? '').toLowerCase(),
  };
}

// ── The daily files and the read cursor ────────────────────────────────────────

interface FileState {
  /** Local-header offset the next read starts at. */
  offset: number;
  /** The file's ETag when the offset was taken; a re-published file starts again from 0. */
  etag: string | null;
  size: number;
  /** Members walked so far (all kinds). */
  members: number;
  done: boolean;
}
/** Per daily file (by its date), what has been read. */
export interface AccountsCursor {
  files: Record<string, FileState>;
}

/** What the stream of this invocation read, held until the store calls `commit`. */
let pending: { cursor: AccountsCursor; notes: string[] } | null = null;

export async function readAccountsCursor(env: CloudflareBindings): Promise<AccountsCursor> {
  const stored = await env.CACHE.get<AccountsCursor>(ACCOUNTS_CURSOR_KEY, 'json');
  return stored && typeof stored.files === 'object' && stored.files !== null
    ? stored
    : { files: {} };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
const DAY_MS = 86_400_000;

/** The file dates to look for, oldest first: the window, plus any older file left unfinished. */
function candidateDates(cursor: AccountsCursor, now: number): string[] {
  const dates = new Set<string>();
  const oldest = isoDay(now - (REMEMBER_DAYS - 1) * DAY_MS);
  for (const [date, state] of Object.entries(cursor.files)) {
    if (!state.done && date >= oldest) dates.add(date);
  }
  for (let back = WINDOW_DAYS - 1; back >= 0; back -= 1) {
    const date = isoDay(now - back * DAY_MS);
    if (!cursor.files[date]?.done) dates.add(date);
  }
  return [...dates].sort();
}

async function readRange(url: string, start: number, end: number): Promise<Uint8Array> {
  // Plain fetch: originFetch peeks at a clone of the body, which a multi-MiB slice must not pay for.
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, range: `bytes=${start}-${end - 1}` },
  });
  if (res.status !== 206) {
    await res.body?.cancel();
    throw new Error(`accounts ZIP range ${start}-${end - 1} answered ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function* streamFromOrigin(env: CloudflareBindings): AsyncGenerator<UkCompanyAccountsRecord> {
  const startedAt = accountsBudget.now();
  const cursor = await readAccountsCursor(env);
  const oldest = isoDay(startedAt - (REMEMBER_DAYS - 1) * DAY_MS);
  for (const date of Object.keys(cursor.files)) {
    if (date < oldest) delete cursor.files[date];
  }
  const notes: string[] = [];
  pending = { cursor, notes };
  let bytesRead = 0;
  let yielded = 0;
  let firstError: Error | null = null;
  const overBudget = (): boolean =>
    accountsBudget.now() - startedAt >= accountsBudget.elapsedMs ||
    bytesRead >= accountsBudget.bytes;

  for (const date of candidateDates(cursor, startedAt)) {
    if (overBudget()) break; // the paused file's note says the rest waits
    const file = accountsFileName(date);
    const url = `${ORIGIN}${file}`;
    const head = await originFetch(url, { method: 'HEAD', headers: { 'user-agent': USER_AGENT } });
    if (head.status === 404 || head.status === 403) continue; // no file that day (Sunday, Monday) or not yet
    if (!head.ok) {
      firstError ??= new Error(`accounts ZIP ${file} HEAD answered ${head.status}`);
      notes.push(`${file} HEAD ${head.status}`);
      continue;
    }
    const size = Number(head.headers.get('content-length') ?? '0');
    const etag = head.headers.get('etag');
    if (!Number.isFinite(size) || size <= 0) {
      firstError ??= new Error(`accounts ZIP ${file} has no content-length`);
      continue;
    }
    const had = cursor.files[date];
    const resumed = had !== undefined && had.etag === etag && had.size === size && had.offset > 0;
    const state: FileState = resumed
      ? { ...had, done: false }
      : { offset: 0, etag, size, members: 0, done: false };
    cursor.files[date] = state;
    const from = state.offset;
    let parsed = 0;
    let skipped = 0;
    let stopped = false;
    try {
      const members = zipMembers({
        read: async (start, end) => {
          const chunk = await readRange(url, start, end);
          bytesRead += chunk.length;
          return chunk;
        },
        size,
        offset: state.offset,
        sliceBytes: accountsBudget.sliceBytes,
      });
      for await (const member of members) {
        const key = memberKey(member.name);
        let record: UkCompanyAccountsRecord | null = null;
        if (key && key.ext === 'html' && member.method === 8) {
          try {
            const html = new TextDecoder().decode(await inflateRaw(member.data, MAX_MEMBER_BYTES));
            record = {
              company_number: key.number,
              balance_sheet_date: key.date,
              ...parseAccounts(html, key.date),
              file_date: date,
              filing_history_url: `${FILING_HISTORY}${key.number}/filing-history`,
            };
          } catch {
            record = null; // one unreadable document never costs the file
          }
        }
        if (record) {
          parsed += 1;
          yielded += 1;
          yield record;
        } else {
          skipped += 1;
        }
        // After the yield: the store has taken the record, so the cursor may pass the member.
        state.offset = member.next;
        state.members += 1;
        if (overBudget()) {
          stopped = true;
          break;
        }
      }
      if (!stopped) state.done = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      firstError ??= error;
      notes.push(`${file} read failed at byte ${state.offset}: ${error.message}`);
      continue;
    }
    const range = `${from > 0 ? `resumed at ${mib(from)}, ` : ''}${parsed} accounts${
      skipped > 0 ? `, ${skipped} skipped` : ''
    }`;
    notes.push(
      state.done
        ? `${file} done (${mib(size)}, ${state.members} members; ${range})`
        : `${file} paused at ${mib(state.offset)} of ${mib(size)} (${range}), resumes next wave`,
    );
  }
  // A day that read nothing AND met an error is the origin's or the reader's failure, not a quiet day.
  if (yielded === 0 && firstError) throw firstError;
  if (notes.length === 0) notes.push('no new daily file');
}

function fixtures(): UkCompanyAccountsRecord[] {
  return z.array(ukCompanyAccountsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkCompanyAccountsRecord> {
  let yielded = 0;
  try {
    for await (const record of streamFromOrigin(env)) {
      yielded += 1;
      yield record;
    }
  } catch (err) {
    if (yielded === 0 && String(env.FIXTURE_FALLBACK) === 'true') {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'fixture_fallback',
          source: 'uk-company-accounts',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      pending = null; // fixtures are not a read of the origin: the cursor stays where it was
      yield* fixtures();
      return;
    }
    pending = null;
    throw err;
  }
}

export const ukCompanyAccountsSource: DataSource<UkCompanyAccountsRecord> = {
  slug: 'uk-company-accounts',
  title: 'UK company accounts — headline financials (Companies House)',
  description:
    'Headline figures from the accounts UK companies file electronically at Companies House, one record per company and balance-sheet date: net assets (negative = net liabilities) with the tag it was read from, cash at bank, creditors due within one year, average employees, the dormant flag, turnover and profit where filed (few small companies file them), and the same figures for the prior period. From the official daily Accounts Data Product (iXBRL), read every morning; the register builds up from 2026-11 onward. Organisation-level numbers only — directors, signatories and narrative notes are never ingested.',
  storage: 'd1',
  append: true,
  stats: {
    date: { field: 'balance_sheet_date', title: 'Accounts by balance-sheet month' },
    groupBy: [{ field: 'net_assets_source', title: 'Where the net-assets figure was tagged' }],
    noun: 'sets of company accounts',
  },
  recordSchema: ukCompanyAccountsRecordSchema,
  queryParams: z.object({
    company_number: z.string().optional(),
    company: z.string().optional(),
    balance_sheet_date_after: z.iso.date().optional(),
    balance_sheet_date_before: z.iso.date().optional(),
    file_date_after: z.iso.date().optional(),
    file_date_before: z.iso.date().optional(),
    dormant: z.stringbool().optional(),
    net_assets_min: z.coerce.number().optional(),
    net_assets_max: z.coerce.number().optional(),
    cash_min: z.coerce.number().optional(),
    cash_max: z.coerce.number().optional(),
    creditors_within_one_year_min: z.coerce.number().optional(),
    employees_min: z.coerce.number().optional(),
    employees_max: z.coerce.number().optional(),
    turnover_min: z.coerce.number().optional(),
    profit_loss_max: z.coerce.number().optional(),
  }),
  refresh: { cron: '10 8 * * *', cacheTtlSeconds: 86_400, wave: 8 },
  idOf: (r) => `${r.company_number}_${r.balance_sheet_date}`,
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkCompanyAccountsRecord[]> {
    const records: UkCompanyAccountsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
  async commit(env: CloudflareBindings): Promise<string | undefined> {
    const read = pending;
    pending = null;
    if (!read) return undefined;
    await env.CACHE.put(ACCOUNTS_CURSOR_KEY, JSON.stringify(read.cursor));
    return read.notes.join('; ');
  },
};

const periodSchema = z.object({
  balance_sheet_date: z.string().nullable(),
  net_assets: z.number().nullable(),
  cash: z.number().nullable(),
  creditors_within_one_year: z.number().nullable(),
  employees: z.number().nullable(),
  turnover: z.number().nullable(),
  profit_loss: z.number().nullable(),
});

/** The slice of the latest accounts the company lookup carries (`uk-company-profiles.financials`). */
export const financialsSummarySchema = z.object({
  balance_sheet_date: z.string(),
  period_start: z.string().nullable(),
  dormant: z.boolean().nullable(),
  net_assets: z.number().nullable(),
  net_assets_source: z.enum(['NetAssetsLiabilities', 'Equity']).nullable(),
  cash: z.number().nullable(),
  creditors_within_one_year: z.number().nullable(),
  employees: z.number().nullable(),
  turnover: z.number().nullable(),
  profit_loss: z.number().nullable(),
  /** The comparative period of the same accounts; null when none was tagged. */
  prior: periodSchema.nullable(),
  /** How many sets of this company's accounts the register holds. */
  filings: z.number().int(),
  file_date: z.string(),
});

export type FinancialsSummary = z.infer<typeof financialsSummarySchema>;

/**
 * The company's latest electronically filed accounts, summarised, or null when the register
 * holds none (paper filer, nothing filed since the register began, or not loaded yet). One
 * indexed read on the record id (`<number>_<date>`); the lookup caches the whole record for
 * 24 h. A failed read is logged and never fails the lookup.
 */
export async function latestFinancials(
  env: CloudflareBindings,
  companyNumber: string,
): Promise<FinancialsSummary | null> {
  const wanted = companyNumber.trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(wanted)) return null;
  let rows: UkCompanyAccountsRecord[];
  try {
    rows = (await readD1ByIdPrefix(
      env,
      ukCompanyAccountsSource,
      `${wanted}_`,
    )) as UkCompanyAccountsRecord[];
  } catch (err) {
    if (!(err instanceof SourceNotLoadedError)) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'financials_join_failed',
          source: 'uk-company-profiles',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    return null;
  }
  if (rows.length === 0) return null;
  const latest = rows.reduce((best, r) =>
    r.balance_sheet_date > best.balance_sheet_date ? r : best,
  );
  const hasPrior =
    latest.prior_balance_sheet_date !== null ||
    latest.prior_net_assets !== null ||
    latest.prior_employees !== null;
  return {
    balance_sheet_date: latest.balance_sheet_date,
    period_start: latest.period_start,
    dormant: latest.dormant,
    net_assets: latest.net_assets,
    net_assets_source: latest.net_assets_source,
    cash: latest.cash,
    creditors_within_one_year: latest.creditors_within_one_year,
    employees: latest.employees,
    turnover: latest.turnover,
    profit_loss: latest.profit_loss,
    prior: hasPrior
      ? {
          balance_sheet_date: latest.prior_balance_sheet_date,
          net_assets: latest.prior_net_assets,
          cash: latest.prior_cash,
          creditors_within_one_year: latest.prior_creditors_within_one_year,
          employees: latest.prior_employees,
          turnover: latest.prior_turnover,
          profit_loss: latest.prior_profit_loss,
        }
      : null,
    filings: rows.length,
    file_date: latest.file_date,
  };
}
