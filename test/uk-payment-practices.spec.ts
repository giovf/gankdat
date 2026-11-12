import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';
import { refreshD1Source } from '../src/sources/d1store';
import {
  latestPaymentPractices,
  ukPaymentPracticesSource,
} from '../src/sources/uk-payment-practices';
import type { UkPaymentPracticesRecord } from '../src/sources/uk-payment-practices';
import { authedFetch, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

const URL_ = 'https://example.com/v1/data/uk-payment-practices';

function load(): Promise<unknown> {
  return refreshD1Source(env, ukPaymentPracticesSource);
}

// The export's 52 columns, verbatim (relay payment-practices-spike-2026-11-12/1.csv).
export const HEADER =
  'Report Id,Policy Regime,Financial period start date,Start date,End date,Filing date,Company,Company number,Qualifying contracts in reporting period,Payments made in reporting period,Qualifying construction contracts in reporting period,Construction contracts have retention clauses,Average time to pay,Total value invoices paid within 30 days,Total value invoices paid between 31 and 60 days,Total value invoices paid later than 60 days,% Invoices paid within 30 days,% Invoices paid between 31 and 60 days,% Invoices paid later than 60 days,Total value invoices paid later than agreed terms,% Invoices not paid within agreed terms,% Invoices not paid due to dispute,Shortest (or only) standard payment period,Longest standard payment period,Standard payment terms,Payment terms have changed,Suppliers notified of changes,Maximum contractual payment period,Maximum contractual payment period information,Other information payment terms,Retention clauses included in all construction contracts,Retention clauses included in standard payment terms,Retention clauses are used in specific circumstances,Description of specific circumstances for retention clauses,Retention clauses used above a specific sum,Value above which retention clauses are used,Retention clauses are at a standard rate,Retention clauses standard rate percentage,Retention clauses have parity with client,Description of parity policy,Retention clause money release description,Retention clause money release is staged,Description of stages for money release,Retention value compared to client retentions as %,Retention value compared to total payments as %,Dispute resolution process,Participates in payment codes,E-Invoicing offered,Supply-chain financing offered,Policy covers charges for remaining on supplier list,Charges have been made for remaining on supplier list,URL';

/** A report row: the 52 cells with the narrative columns carrying text that must never be served. */
function row(cells: Partial<Record<number, string>>): string {
  const out = new Array<string>(52).fill('');
  for (const [i, v] of Object.entries(cells)) out[Number(i)] = v ?? '';
  return out.join(',');
}
export const ROWS = [
  // Medtronic, the export's first row: quoted narrative with commas and a newline, "No" in the codes column.
  row({
    0: '2',
    1: 'Regime-1',
    2: 'None',
    3: '2017-04-29',
    4: '2017-10-28',
    5: '2017-11-07',
    6: 'MEDTRONIC LIMITED',
    7: '01070807',
    8: 'True',
    9: 'False',
    10: 'False',
    11: 'False',
    12: '25',
    16: '77',
    17: '20',
    18: '3',
    19: '0',
    20: '89',
    21: '0',
    22: '30',
    23: '60',
    24: '"Standard contractual terms, for goods and services\nis 60 days."',
    27: '60',
    45: '"Contact Jane Doe, Accounts Payable, Prague. The PO number is communicated by procurement."',
    46: 'No',
    47: 'True',
    48: 'False',
    49: 'False',
    50: 'False',
    51: 'https://check-payment-practices.service.gov.uk/report/2',
  }),
  // The fixture company of the lookup spec, two periods: the join must pick the later one.
  row({
    0: '111700',
    3: '2025-10-01',
    4: '2026-03-31',
    5: '2026-05-01',
    6: 'EXAMPLE WIDGETS LIMITED',
    7: '12345678',
    8: 'True',
    9: 'True',
    12: '31',
    16: '58',
    17: '35',
    18: '7',
    20: '39',
    21: '2',
    22: '30',
    23: '90',
    27: '120',
    25: 'True',
    26: 'True',
    46: 'Yes',
    47: 'True',
    48: 'True',
    49: 'True',
    50: 'False',
    51: 'https://check-payment-practices.service.gov.uk/report/111700',
  }),
  row({
    0: '118366',
    3: '2026-04-01',
    4: '2026-09-30',
    5: '2026-10-30',
    6: 'EXAMPLE WIDGETS LIMITED',
    7: '12345678',
    8: 'True',
    9: 'True',
    12: '27.5',
    16: '66.4',
    17: '30.1',
    18: '3.5',
    20: '18',
    21: '1',
    22: '30',
    23: '60',
    46: 'Yes',
    47: 'True',
    48: 'False',
    51: 'https://check-payment-practices.service.gov.uk/report/118366',
  }),
  // A row with no company number is skipped; one with no URL gets the report page.
  row({ 0: '5', 6: 'NO NUMBER PLC', 12: '40' }),
  row({ 0: '6', 6: 'SLOW PAYER LIMITED', 7: 'SC999999', 12: '71', 20: '55', 46: 'False' }),
];
export const CSV = [HEADER, ...ROWS].join('\r\n') + '\r\n';

export function chunked(text: string, size = 512): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    }),
    { headers: { 'content-type': 'text/csv' } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /v1/data/uk-payment-practices', () => {
  it('streams the export, keeps the statistics and policy answers, never the narrative', async () => {
    stubOrigins({ paymentPractices: () => chunked(CSV) });
    await load();
    const res = await authedFetch(URL_);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const banned of [
      'Jane Doe',
      'Prague',
      'procurement',
      'Standard contractual',
      'Regime-1',
    ]) {
      expect(text).not.toContain(banned);
    }
    const body = JSON.parse(text) as SuccessEnvelope<UkPaymentPracticesRecord[]>;
    expect(body.data).toHaveLength(4); // the numberless row is skipped
    expect(body.data[0]).toEqual({
      report_id: 2,
      company_number: '01070807',
      company: 'MEDTRONIC LIMITED',
      period_start: '2017-04-29',
      period_end: '2017-10-28',
      filed_on: '2017-11-07',
      average_days_to_pay: 25,
      paid_within_30_days_pct: 77,
      paid_31_to_60_days_pct: 20,
      paid_after_60_days_pct: 3,
      not_paid_within_terms_pct: 89,
      disputed_pct: 0,
      shortest_standard_terms_days: 30,
      longest_standard_terms_days: 60,
      max_contractual_days: 60,
      terms_changed: null,
      suppliers_notified: null,
      qualifying_contracts: true,
      payments_made: false,
      construction_contracts: false,
      construction_retention_clauses: false,
      participates_in_payment_codes: false,
      e_invoicing_offered: true,
      supply_chain_financing_offered: false,
      supplier_list_charges_policy: false,
      supplier_list_charges_made: false,
      report_url: 'https://check-payment-practices.service.gov.uk/report/2',
    });
    const widgets = body.data.filter((r) => r.company_number === '12345678');
    expect(widgets.map((r) => r.report_id)).toEqual([111700, 118366]);
    expect(widgets[1]?.average_days_to_pay).toBeNull(); // "27.5" is not an integer day count
    expect(widgets[1]?.paid_within_30_days_pct).toBe(66.4);
    expect(widgets[1]?.participates_in_payment_codes).toBe(true); // "Yes"
    const slow = body.data.find((r) => r.company_number === 'SC999999');
    expect(slow?.report_url).toBe('https://check-payment-practices.service.gov.uk/report/6');
    expect(slow?.period_end).toBeNull();
  });

  it('filters by company number, thresholds, dates and policy answers', async () => {
    stubOrigins({ paymentPractices: () => chunked(CSV) });
    await load();
    const { key } = await issueKey();
    const ids = async (qs: string): Promise<number[]> => {
      const body = (await (await authedFetch(`${URL_}?${qs}`, key)).json()) as SuccessEnvelope<
        UkPaymentPracticesRecord[]
      >;
      return body.data.map((r) => r.report_id);
    };
    expect(await ids('company_number=12345678')).toEqual([111700, 118366]);
    expect(await ids('company=widgets')).toEqual([111700, 118366]);
    expect(await ids('report_id=118366')).toEqual([118366]);
    expect(await ids('average_days_to_pay_min=40')).toEqual([6]);
    expect(await ids('average_days_to_pay_max=30')).toEqual([2]);
    expect(await ids('not_paid_within_terms_pct_min=50')).toEqual([2, 6]);
    expect(await ids('period_end_after=2026-01-01')).toEqual([111700, 118366]);
    expect(await ids('filed_on_before=2018-01-01')).toEqual([2]);
    expect(await ids('participates_in_payment_codes=true')).toEqual([111700, 118366]);
    expect(await ids('e_invoicing_offered=true&supply_chain_financing_offered=true')).toEqual([
      111700,
    ]);
  });

  it('treats a lost required column as a failed origin: fixtures when allowed, nothing else', async () => {
    // FIXTURE_FALLBACK is on in the test env, so the format-changed error (thrown before any row
    // is yielded) lands on the bundled fixtures and the warn line; in production it is the night's
    // error row and the previous generation keeps serving.
    const broken = CSV.replace('Average time to pay', 'Average days');
    stubOrigins({ paymentPractices: () => chunked(broken) });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await load();
    expect(logs.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /fixture_fallback.*format changed — missing: Average time to pay/,
    );
    logs.mockRestore();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkPaymentPracticesRecord[]
    >;
    expect(body.meta?.total).toBe(13);
  });

  it('falls back to bundled fixtures when the origin fails', async () => {
    stubOrigins({ paymentPractices: () => new Response('nope', { status: 503 }) });
    await load();
    const body = (await (await authedFetch(URL_)).json()) as SuccessEnvelope<
      UkPaymentPracticesRecord[]
    >;
    expect(body.meta?.total).toBe(13);
    expect(body.data.every((r) => /^[0-9A-Z]{8}$/.test(r.company_number))).toBe(true);
  });
});

describe('latestPaymentPractices (the company lookup join)', () => {
  it('is null before the register loads and for a company that never reported', async () => {
    expect(await latestPaymentPractices(env, '12345678')).toBeNull();
    stubOrigins({ paymentPractices: () => chunked(CSV) });
    await load();
    expect(await latestPaymentPractices(env, '00000006')).toBeNull();
    expect(await latestPaymentPractices(env, '')).toBeNull();
  });

  it('summarises the newest period of the exact company number, with the report count', async () => {
    stubOrigins({ paymentPractices: () => chunked(CSV) });
    await load();
    expect(await latestPaymentPractices(env, '12345678')).toEqual({
      report_id: 118366,
      period_start: '2026-04-01',
      period_end: '2026-09-30',
      filed_on: '2026-10-30',
      average_days_to_pay: null,
      paid_within_30_days_pct: 66.4,
      paid_31_to_60_days_pct: 30.1,
      paid_after_60_days_pct: 3.5,
      not_paid_within_terms_pct: 18,
      disputed_pct: 1,
      participates_in_payment_codes: true,
      reports: 2,
      report_url: 'https://check-payment-practices.service.gov.uk/report/118366',
    });
    // A substring of the number is not the company ("2345678" would match 12345678 as text).
    expect(await latestPaymentPractices(env, '2345678')).toBeNull();
  });
});
