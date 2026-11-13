import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import { cronOfSource } from '../src/sources/store';
import {
  ACCOUNTS_CURSOR_KEY,
  accountsBudget,
  latestFinancials,
  memberKey,
  parseAccounts,
  readAccountsCursor,
  ukCompanyAccountsSource,
} from '../src/sources/uk-company-accounts';
import type { UkCompanyAccountsRecord } from '../src/sources/uk-company-accounts';
import { zipMembers } from '../src/sources/zip';
import type { ZipMember } from '../src/sources/zip';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-company-accounts';
const NOW = Date.parse('2026-11-13T08:10:00Z');
const realBudget = { ...accountsBudget };

beforeEach(() => {
  accountsBudget.now = (): number => NOW;
});
afterEach(() => {
  Object.assign(accountsBudget, realBudget);
  vi.unstubAllGlobals();
});

function load(): Promise<unknown> {
  return refreshD1Source(env, ukCompanyAccountsSource);
}

// ── A ZIP as Companies House writes it: deflate, flag 0, sizes in the local header ──

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
interface Entry {
  name: string;
  body: string;
  /** Stored (method 0) instead of deflated — the nested-ZIP members. */
  stored?: boolean;
  /** General-purpose flag bit 3: sizes after the data. */
  descriptor?: boolean;
}
async function zipOf(entries: Entry[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let central = 0;
  for (const entry of entries) {
    const raw = encoder.encode(entry.body);
    const data = entry.stored ? raw : await deflateRaw(raw);
    const name = encoder.encode(entry.name);
    const header = new Uint8Array(30);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(6, entry.descriptor ? 0x8 : 0, true);
    view.setUint16(8, entry.stored ? 0 : 8, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, raw.length, true);
    view.setUint16(26, name.length, true);
    parts.push(header, name, data);
    central += 1;
  }
  // The central directory's first header ends the walk; its content is never read.
  const directory = new Uint8Array(46 * central + 22);
  new DataView(directory.buffer).setUint32(0, 0x02014b50, true);
  parts.push(directory);
  return concat(parts);
}

/** HEAD + Range GET over a set of dated ZIPs; any other date answers 404. */
function accountsOrigin(
  files: Record<string, Uint8Array>,
  calls: string[] = [],
): (url: string, init?: RequestInit) => Response {
  return (url, init) => {
    const date = /Accounts_Bulk_Data-(\d{4}-\d{2}-\d{2})\.zip$/.exec(url)?.[1] ?? '';
    const zip = files[date];
    const method = init?.method ?? 'GET';
    if (!zip) return new Response('Not Found', { status: 404 });
    if (method === 'HEAD') {
      calls.push(`HEAD ${date}`);
      return new Response(null, {
        status: 200,
        headers: { 'content-length': String(zip.length), etag: `"${date}-${zip.length}"` },
      });
    }
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('range') ?? '');
    if (!range) return new Response('range required', { status: 200 });
    calls.push(`GET ${date} ${range[1]}-${range[2]}`);
    return new Response(zip.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
  };
}

// ── iXBRL documents, cut from the shapes in the 2026-11-11 file ──

const ctx = (id: string, period: string, member = ''): string =>
  `<xbrli:context id="${id}"><xbrli:entity><xbrli:identifier scheme="http://www.companieshouse.gov.uk/">X</xbrli:identifier>${
    member
      ? `<xbrli:segment>${member
          .split('+')
          .map(
            (m) => `<xbrldi:explicitMember dimension="core:Dim">core:${m}</xbrldi:explicitMember>`,
          )
          .join('')}</xbrli:segment>`
      : ''
  }</xbrli:entity><xbrli:period>${period}</xbrli:period></xbrli:context>`;
const instant = (d: string): string => `<xbrli:instant>${d}</xbrli:instant>`;
const duration = (a: string, b: string): string =>
  `<xbrli:startDate>${a}</xbrli:startDate><xbrli:endDate>${b}</xbrli:endDate>`;
const fact = (name: string, context: string, text: string, extra = ''): string =>
  `<ix:nonFraction contextRef="${context}" decimals="0" format="ixt2:numdotdecimal" name="${name}" unitRef="GBP"${extra}>${text}</ix:nonFraction>`;

/** A full small-company set: both periods, a signed loss, dimensioned creditors and equity classes. */
const FULL = `<html><body><ix:header><ix:resources>
${ctx('I0', instant('2026-04-30'))}${ctx('I5', instant('2025-04-30'))}
${ctx('I6', instant('2026-04-30'), 'CurrentFinancialInstruments+WithinOneYear')}
${ctx('I7', instant('2025-04-30'), 'CurrentFinancialInstruments+WithinOneYear')}
${ctx('I8', instant('2026-04-30'), 'Non-currentFinancialInstruments+AfterOneYear')}
${ctx('I10', instant('2026-04-30'), 'ShareCapital')}
${ctx('D0', duration('2025-05-01', '2026-04-30'))}${ctx('D11', duration('2024-05-01', '2025-04-30'))}
${ctx('D5', duration('2025-05-01', '2026-04-30'), 'Director1')}
</ix:resources></ix:header>
<ix:nonNumeric contextRef="D0" name="bus:ReportSection"><div>
<ix:nonNumeric contextRef="D0" name="bus:EntityCurrentLegalOrRegisteredName">HATCHER &amp; SONS LIMITED</ix:nonNumeric>
<ix:nonNumeric contextRef="D0" name="bus:EntityDormantTruefalse">false</ix:nonNumeric>
<ix:nonNumeric contextRef="D5" name="bus:NameEntityOfficer">A M Hill</ix:nonNumeric>
<p>The director Jane Signatory approved these accounts.</p></div></ix:nonNumeric>
${fact('core:CashBankOnHand', 'I0', ' 3,550')}${fact('core:CashBankOnHand', 'I5', ' 4,100')}
${fact('core:Creditors', 'I6', ' 354,521')}${fact('core:Creditors', 'I7', '348,644')}${fact('core:Creditors', 'I8', '458,467')}
${fact('core:NetAssetsLiabilities', 'I0', '<span>2,706</span>', ' scale="3"')}
${fact('core:NetAssetsLiabilities', 'I5', '(12,500)', ' sign="-"')}
${fact('core:Equity', 'I10', '114,850')}${fact('core:Equity', 'I0', '2,706,000')}
${fact('core:AverageNumberEmployeesDuringPeriod', 'D0', '39')}${fact('core:AverageNumberEmployeesDuringPeriod', 'D11', '41', ' sign="-"')}
${fact('core:ProfitLoss', 'D0', '8,000', ' sign="-"')}
</body></html>`;

/** A micro-entity balance sheet: total equity only, no net-assets tag, a dash for nil cash. */
const MICRO = `<html><body>
${ctx('icur', instant('2026-03-31'))}${ctx('iprev', instant('2025-03-31'))}${ctx('dcur', duration('2025-04-01', '2026-03-31'))}
<ix:nonNumeric contextRef="dcur" name="uk-bus:EntityCurrentLegalOrRegisteredName">Forester Holdings Limited</ix:nonNumeric>
<ix:nonNumeric contextRef="dcur" name="uk-bus:EntityDormantTruefalse" format="ixt2:booleantrue">Yes</ix:nonNumeric>
${fact('uk-core:Equity', 'icur', '356.214,00', '').replace('numdotdecimal', 'numdotcomma')}
${fact('uk-core:Equity', 'iprev', '326,632')}
${fact('uk-core:CashBankInHand', 'icur', '-').replace('numdotdecimal', 'zerodash')}
${fact('uk-core:EmployeesTotal', 'dcur', '1')}
</body></html>`;

const MEMBERS: Entry[] = [
  { name: 'Prod223_4348_00056710_20260430.html', body: FULL },
  { name: 'Prod223_4348_00184013_20260331.html', body: MICRO },
  { name: 'Prod223_4348_00999999_20260331.xml', body: '<xbrl>old XBRL, not read</xbrl>' },
  {
    name: 'Prod223_4348_OC310831_20251231.html',
    body: MICRO.replaceAll('2026-03-31', '2025-12-31'),
  },
];

async function allMembers(zip: Uint8Array, offset = 0, sliceBytes = 64): Promise<ZipMember[]> {
  const out: ZipMember[] = [];
  const walk = zipMembers({
    read: (start, end) => Promise.resolve(zip.slice(start, end)),
    size: zip.length,
    offset,
    sliceBytes,
  });
  for await (const member of walk) out.push({ ...member, data: member.data.slice() });
  return out;
}

describe('zipMembers (the per-member walker)', () => {
  it('yields every member across small slices and stops at the central directory', async () => {
    const zip = await zipOf(MEMBERS);
    const members = await allMembers(zip);
    expect(members.map((m) => m.name)).toEqual(MEMBERS.map((m) => m.name));
    expect(members[0]?.offset).toBe(0);
    expect(members[1]?.offset).toBe(members[0]?.next);
    expect(members.every((m) => m.method === 8)).toBe(true);
    expect(members[0]?.uncompressedSize).toBe(new TextEncoder().encode(FULL).length);
  });

  it('resumes at any member boundary', async () => {
    const zip = await zipOf(MEMBERS);
    const [first, second] = await allMembers(zip);
    const rest = await allMembers(zip, second?.next ?? -1, 1024);
    expect(rest.map((m) => m.name)).toEqual(MEMBERS.slice(2).map((m) => m.name));
    expect((await allMembers(zip, first?.next ?? -1)).length).toBe(3);
  });

  it('hands a stored member over as is and rejects a data descriptor or a cut file', async () => {
    const stored = await allMembers(
      await zipOf([{ name: 'a.zip', body: 'PKnested', stored: true }]),
    );
    expect(stored[0]?.method).toBe(0);
    expect(new TextDecoder().decode(stored[0]?.data)).toBe('PKnested');
    await expect(
      allMembers(await zipOf([{ name: 'a.html', body: 'x', descriptor: true }])),
    ).rejects.toThrow(/data descriptor/);
    const zip = await zipOf(MEMBERS);
    await expect(allMembers(zip.slice(0, 200))).rejects.toThrow(/ZIP ended inside/);
    await expect(allMembers(zip, 7)).rejects.toThrow(/no ZIP entry at byte 7/);
  });
});

describe('parseAccounts (the iXBRL regex pass)', () => {
  it('reads the whole-entity facts of both periods with sign, scale and nested text', () => {
    expect(parseAccounts(FULL, '2026-04-30')).toEqual({
      company: 'HATCHER & SONS LIMITED',
      period_start: '2025-05-01',
      dormant: false,
      net_assets: 2_706_000, // 2,706 at scale 3, the figure inside a <span>
      net_assets_source: 'NetAssetsLiabilities',
      cash: 3550,
      creditors_within_one_year: 354_521, // the within-one-year context, not the after-one-year one
      employees: 39,
      turnover: null,
      profit_loss: -8000,
      prior_balance_sheet_date: '2025-04-30',
      prior_net_assets: -12_500, // sign="-"; the brackets are presentation
      prior_cash: 4100,
      prior_creditors_within_one_year: 348_644,
      prior_employees: 41, // a signed employee count is read as absolute
      prior_turnover: null,
      prior_profit_loss: null,
    });
  });

  it('falls back to total equity, labelled, and reads comma decimals, dashes and fixed booleans', () => {
    const figures = parseAccounts(MICRO, '2026-03-31');
    expect(figures).toMatchObject({
      company: 'Forester Holdings Limited',
      dormant: true,
      net_assets: 356_214,
      net_assets_source: 'Equity',
      prior_net_assets: 326_632,
      cash: 0,
      employees: 1,
      creditors_within_one_year: null,
    });
  });

  it('reports nothing for a period the document does not tag', () => {
    const figures = parseAccounts(FULL, '2030-01-01');
    expect(figures.net_assets).toBeNull();
    expect(figures.net_assets_source).toBeNull();
    expect(figures.prior_balance_sheet_date).toBeNull();
    expect(figures.company).toBe('HATCHER & SONS LIMITED');
  });

  it('takes the key from the member name', () => {
    expect(memberKey('Prod223_4348_oc310831_20251231.html')).toEqual({
      number: 'OC310831',
      date: '2025-12-31',
      ext: 'html',
    });
    expect(memberKey('readme.txt')).toBeNull();
  });
});

async function records(qs = ''): Promise<UkCompanyAccountsRecord[]> {
  const body = (await (await authedFetch(`${URL_}?${qs}`)).json()) as SuccessEnvelope<
    UkCompanyAccountsRecord[]
  >;
  return body.data;
}
async function lastLog(): Promise<{ status: string; records: number; message: string | null }> {
  const row = await env.DB.prepare(
    "SELECT status, records, message FROM refresh_log WHERE source_slug = 'uk-company-accounts' ORDER BY id DESC LIMIT 1",
  ).first<{ status: string; records: number; message: string | null }>();
  return row!;
}

describe('uk-company-accounts refresh (an accumulating register)', () => {
  it('loads a day’s file, serves money and counts only, and keeps the cursor', async () => {
    const zip = await zipOf(MEMBERS);
    const calls: string[] = [];
    stubOrigins({ companyAccounts: accountsOrigin({ '2026-11-12': zip }, calls) });
    await load();

    const res = await authedFetch(URL_);
    const text = await res.text();
    for (const banned of ['A M Hill', 'Jane Signatory', 'NameEntityOfficer']) {
      expect(text).not.toContain(banned);
    }
    const body = JSON.parse(text) as SuccessEnvelope<UkCompanyAccountsRecord[]>;
    expect(body.data.map((r) => `${r.company_number}_${r.balance_sheet_date}`)).toEqual([
      '00056710_2026-04-30',
      '00184013_2026-03-31',
      'OC310831_2025-12-31',
    ]);
    expect(body.data[0]).toMatchObject({
      company: 'HATCHER & SONS LIMITED',
      net_assets: 2_706_000,
      prior_net_assets: -12_500,
      file_date: '2026-11-12',
      filing_history_url:
        'https://find-and-update.company-information.service.gov.uk/company/00056710/filing-history',
    });

    // Seven dated HEADs (the window), one Range read of the only file that exists.
    expect(calls.filter((c) => c.startsWith('HEAD'))).toEqual(['HEAD 2026-11-12']);
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(1);
    const log = await lastLog();
    expect(log.status).toBe('ok');
    expect(log.records).toBe(3);
    expect(log.message).toMatch(
      /^append \+3 ~0; Accounts_Bulk_Data-2026-11-12\.zip done \(0\.0 MiB, 4 members; 3 accounts, 1 skipped\)$/,
    );
    const cursor = await readAccountsCursor(env);
    expect(cursor.files['2026-11-12']).toMatchObject({ done: true, members: 4 });
  });

  it('adds the next day’s filings without removing yesterday’s, and a quiet day is ok', async () => {
    const day1 = await zipOf(MEMBERS.slice(0, 2));
    stubOrigins({ companyAccounts: accountsOrigin({ '2026-11-12': day1 }) });
    await load();
    expect((await records()).length).toBe(2);

    // Next morning: a new file with one new company and one re-filed (amended) set.
    accountsBudget.now = (): number => NOW + 86_400_000;
    const amended = FULL.replace(' 3,550', ' 9,999');
    const day2 = await zipOf([
      { name: 'Prod223_4348_00056710_20260430.html', body: amended },
      MEMBERS[3]!,
    ]);
    const calls: string[] = [];
    stubOrigins({
      companyAccounts: accountsOrigin({ '2026-11-12': day1, '2026-11-13': day2 }, calls),
    });
    await load();
    expect(calls.filter((c) => c.startsWith('HEAD'))).toEqual(['HEAD 2026-11-13']); // 11-12 is done
    const all = await records();
    expect(all.map((r) => r.company_number)).toEqual(['00056710', '00184013', 'OC310831']);
    expect(all[0]?.cash).toBe(9999);
    expect(all[0]?.file_date).toBe('2026-11-13');
    expect((await lastLog()).message).toMatch(/^append \+1 ~1; /);

    const { key } = await issueKey();
    const changes = (await (
      await authedFetch('https://example.com/v1/changes/uk-company-accounts', key)
    ).json()) as SuccessEnvelope<{ change: string; record_id: string }[]>;
    expect(changes.data.map((c) => `${c.change} ${c.record_id}`).sort()).toEqual([
      'added 00056710_2026-04-30',
      'added 00184013_2026-03-31',
      'added OC310831_2025-12-31',
      'changed 00056710_2026-04-30',
    ]);

    // Sunday: no file at all. Nothing is removed, the row says so.
    accountsBudget.now = (): number => NOW + 3 * 86_400_000;
    stubOrigins({ companyAccounts: accountsOrigin({}) });
    await load();
    expect((await records()).length).toBe(3);
    const log = await lastLog();
    expect(log).toMatchObject({ status: 'ok', records: 3 });
    expect(log.message).toBe('append +0 ~0; no new daily file');
  });

  it('stops at the byte budget and resumes at the kept offset on the next wave', async () => {
    const many: Entry[] = Array.from({ length: 9 }, (_, i) => ({
      name: `Prod223_4348_0000000${i + 1}_20260331.html`,
      body: MICRO,
    }));
    const zip = await zipOf(many);
    accountsBudget.sliceBytes = 256;
    accountsBudget.bytes = Math.floor(zip.length / 3);
    const calls: string[] = [];
    stubOrigins({ companyAccounts: accountsOrigin({ '2026-11-12': zip }, calls) });
    await load();
    const first = await readAccountsCursor(env);
    const state = first.files['2026-11-12']!;
    expect(state.done).toBe(false);
    expect(state.offset).toBeGreaterThan(0);
    expect(state.offset).toBeLessThan(zip.length);
    const partial = (await records('per_page=100')).length;
    expect(partial).toBe(state.members);
    expect(partial).toBeLessThan(9);
    expect((await lastLog()).message).toMatch(
      /Accounts_Bulk_Data-2026-11-12\.zip paused at .* resumes next wave$/,
    );

    // The next waves start at the offset, never at byte 0 again.
    calls.length = 0;
    accountsBudget.bytes = realBudget.bytes;
    await load();
    const gets = calls.filter((c) => c.startsWith('GET'));
    expect(gets[0]).toMatch(new RegExp(`^GET 2026-11-12 ${state.offset}-`));
    expect((await records('per_page=100')).map((r) => r.company_number)).toEqual(
      many.map((_, i) => `0000000${i + 1}`),
    );
    expect((await readAccountsCursor(env)).files['2026-11-12']?.done).toBe(true);
    expect((await lastLog()).message).toMatch(/done \(.*9 members; resumed at /);
  });

  it('starts a re-published file again from byte 0', async () => {
    const zip = await zipOf(MEMBERS);
    await env.CACHE.put(
      ACCOUNTS_CURSOR_KEY,
      JSON.stringify({
        files: {
          '2026-11-12': { offset: 40, etag: '"older"', size: 1, members: 1, done: false },
        },
      }),
    );
    stubOrigins({ companyAccounts: accountsOrigin({ '2026-11-12': zip }) });
    await load();
    expect((await records()).length).toBe(3);
  });

  it('filters by number, dates, thresholds and the dormant flag', async () => {
    stubOrigins({ companyAccounts: accountsOrigin({ '2026-11-12': await zipOf(MEMBERS) }) });
    await load();
    const numbers = async (qs: string): Promise<string[]> =>
      (await records(qs)).map((r) => r.company_number);
    expect(await numbers('company_number=00056710')).toEqual(['00056710']);
    expect(await numbers('company=forester')).toEqual(['00184013', 'OC310831']);
    expect(await numbers('dormant=true')).toEqual(['00184013', 'OC310831']);
    expect(await numbers('net_assets_min=1000000')).toEqual(['00056710']);
    expect(await numbers('cash_max=0')).toEqual(['00184013', 'OC310831']);
    expect(await numbers('employees_min=10')).toEqual(['00056710']);
    expect(await numbers('balance_sheet_date_before=2026-01-01')).toEqual(['OC310831']);
    expect(await numbers('file_date_after=2026-11-13')).toEqual([]);
    expect(await numbers('profit_loss_max=-1')).toEqual(['00056710']);
  });

  it('falls back to the bundled fixtures when the origin fails, leaving the cursor alone', async () => {
    stubOrigins({ companyAccounts: () => new Response('nope', { status: 503 }) });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await load();
    expect(logs.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /fixture_fallback.*HEAD answered 503/,
    );
    logs.mockRestore();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkCompanyAccountsRecord[]
    >;
    expect(body.meta?.total).toBe(12);
    expect(await env.CACHE.get(ACCOUNTS_CURSOR_KEY)).toBeNull();
  });

  it('rides its own wave after Companies House publishes', () => {
    expect(cronOfSource(ukCompanyAccountsSource)).toBe('10 8 * * *');
    expect(ukCompanyAccountsSource.append).toBe(true);
  });
});

describe('latestFinancials (the company lookup join)', () => {
  it('is null before the register loads, for a non-filer and for a malformed number', async () => {
    expect(await latestFinancials(env, '00056710')).toBeNull();
    stubOrigins({ companyAccounts: accountsOrigin({ '2026-11-12': await zipOf(MEMBERS) }) });
    await load();
    expect(await latestFinancials(env, '00000006')).toBeNull();
    expect(await latestFinancials(env, '0005671')).toBeNull(); // a prefix is not the company
    expect(await latestFinancials(env, '')).toBeNull();
  });

  it('summarises the newest balance sheet of the exact company, with its prior period', async () => {
    const older = FULL.replaceAll('2026-04-30', '2024-04-30');
    const zip = await zipOf([
      MEMBERS[0]!,
      { name: 'Prod223_4348_00056710_20240430.html', body: older },
      MEMBERS[1]!,
    ]);
    stubOrigins({ companyAccounts: accountsOrigin({ '2026-11-12': zip }) });
    await load();
    expect(await latestFinancials(env, '00056710')).toEqual({
      balance_sheet_date: '2026-04-30',
      period_start: '2025-05-01',
      dormant: false,
      net_assets: 2_706_000,
      net_assets_source: 'NetAssetsLiabilities',
      cash: 3550,
      creditors_within_one_year: 354_521,
      employees: 39,
      turnover: null,
      profit_loss: -8000,
      prior: {
        balance_sheet_date: '2025-04-30',
        net_assets: -12_500,
        cash: 4100,
        creditors_within_one_year: 348_644,
        employees: 41,
        turnover: null,
        profit_loss: null,
      },
      filings: 2,
      file_date: '2026-11-12',
    });
  });
});
