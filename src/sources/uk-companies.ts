import { z } from 'zod';
import fixtureItems from './fixtures/uk-companies.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// Companies House — new UK incorporations (task 42). The register is public
// by statute (Companies Act 2006) and Companies House's personal-information
// charter explicitly contemplates commercial reuse products; Crown copyright,
// attribute Companies House.
//
// Scope (spike 2026-07-13, logged on the task): a full-register mirror is
// infeasible (5.4M companies) and unnecessary — the product is the freshest
// incorporations window via the advanced-search API (~1,000 new companies
// per weekday). Days are fetched newest-first and each day completes before
// the next starts, so the snapshot cap always holds whole, freshest days.
//
// Blind Mode / minimization: company-level fields only. Officer and PSC
// endpoints are never called, and registered-office address LINES are
// dropped at ingest (they can be residential) — locality/region/postcode
// serve the lead-gen and KYB jobs. Requires COMPANIES_HOUSE_API_KEY
// (HTTP Basic, key as username; 600 requests / 5 min — a refresh uses at most
// WINDOW_DAYS × MAX_PAGES_PER_DAY = 35, ~15 on a normal week).
const ORIGIN_URL = 'https://api.company-information.service.gov.uk/advanced-search/companies';
const PAGE_SIZE = 1000;
const WINDOW_DAYS = 7;
/**
 * Snapshot cap — the window, not a page or two of it (gankdat `uk-companies-snapshot-window-cap`,
 * 2026-11-10): at 2,000 the walk stopped inside the second day (`snapshot_truncated fetched=2357 /
 * 2774 / 2032` on 11-08..11-10) and the "newest incorporations" snapshot held ~1.2 days of a register
 * that adds ~2,000–2,800 companies a weekday, so an Apify run asking for the week got a day. Seven
 * days is ≤ ~14,000 rows (weekends near zero) — ~6 MB of KV at ~400 bytes a record, well under the
 * 25 MB value limit — and the snapshot's request-path cost is one KV read and one JSON parse.
 */
const MAX_RECORDS = 15_000;
/**
 * Pages one day may take: 5,000 rows, near double the busiest day seen. It bounds the loop when
 * the origin returns full pages whose items all fail to parse (schema drift) — without it
 * `records` never grows and the loop would run to the Worker subrequest cap — and a day past it
 * is logged `snapshot_day_truncated` rather than silently cut.
 */
const MAX_PAGES_PER_DAY = 5;

const rawItemSchema = z.object({
  company_name: z.string(),
  company_number: z.string(),
  company_status: z.string().nullish(),
  company_type: z.string().nullish(),
  date_of_creation: z.string().nullish(),
  sic_codes: z.array(z.coerce.string()).nullish(),
  registered_office_address: z
    .object({
      locality: z.string().nullish(),
      region: z.string().nullish(),
      postal_code: z.string().nullish(),
      country: z.string().nullish(),
    })
    .nullish(),
});

const searchSchema = z.object({
  hits: z.number().nullish(),
  items: z.array(z.unknown()).nullish(),
});

export const ukCompaniesRecordSchema = z.object({
  company_number: z.string(),
  company: z.string(),
  status: z.string().nullable(),
  company_type: z.string().nullable(),
  incorporated_on: z.string().nullable(),
  sic_codes: z.array(z.string()),
  locality: z.string().nullable(),
  region: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
  company_url: z.string(),
});

export type UkCompaniesRecord = z.infer<typeof ukCompaniesRecordSchema>;

function normalize(raw: z.infer<typeof rawItemSchema>): UkCompaniesRecord {
  const address = raw.registered_office_address ?? undefined;
  return {
    company_number: raw.company_number,
    company: raw.company_name,
    status: raw.company_status ?? null,
    company_type: raw.company_type ?? null,
    incorporated_on: raw.date_of_creation ?? null,
    sic_codes: raw.sic_codes ?? [],
    locality: address?.locality ?? null,
    region: address?.region ?? null,
    postal_code: address?.postal_code ?? null,
    country: address?.country ?? null,
    company_url: `https://find-and-update.company-information.service.gov.uk/company/${raw.company_number}`,
  };
}

function mapItems(items: unknown[]): UkCompaniesRecord[] {
  const records: UkCompaniesRecord[] = [];
  for (const item of items) {
    const parsed = rawItemSchema.safeParse(item);
    if (parsed.success) records.push(normalize(parsed.data));
  }
  return records;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function fetchFromOrigin(key: string): Promise<UkCompaniesRecord[]> {
  const auth = `Basic ${btoa(`${key}:`)}`;
  const records: UkCompaniesRecord[] = [];
  // One count per day of the window, newest first — the log line that replaced the nightly
  // `snapshot_truncated` warning, so the Daily numbers reading shows the register's pace.
  const days: { date: string; n: number }[] = [];
  for (let day = 0; day < WINDOW_DAYS && records.length < MAX_RECORDS; day += 1) {
    const date = isoDaysAgo(day);
    let n = 0;
    let hits: number | null = null;
    let pageNum = 0;
    for (
      let startIndex = 0;
      records.length < MAX_RECORDS && pageNum < MAX_PAGES_PER_DAY;
      startIndex += PAGE_SIZE, pageNum += 1
    ) {
      const url = `${ORIGIN_URL}?incorporated_from=${date}&incorporated_to=${date}&size=${PAGE_SIZE}&start_index=${startIndex}`;
      const res = await originFetch(url, {
        headers: { authorization: auth, 'user-agent': 'gankdat.com data refresh' },
      });
      if (!res.ok) throw new Error(`company-information.service.gov.uk responded ${res.status}`);
      const page = searchSchema.parse(await res.json());
      const items = page.items ?? [];
      hits = page.hits ?? null;
      const mapped = mapItems(items);
      n += mapped.length;
      records.push(...mapped);
      // A short page is the day's last; so is the page that reaches the day's own count.
      if (items.length < PAGE_SIZE) break;
      if (hits !== null && startIndex + items.length >= hits) break;
    }
    days.push({ date, n });
    if (pageNum >= MAX_PAGES_PER_DAY && hits !== null && hits > pageNum * PAGE_SIZE) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'snapshot_day_truncated',
          source: 'uk-companies',
          date,
          hits,
          fetched: n,
        }),
      );
    }
  }
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'snapshot_window',
      source: 'uk-companies',
      days: days.map((d) => `${d.date}:${d.n}`).join(','),
      total: Math.min(records.length, MAX_RECORDS),
    }),
  );
  if (records.length >= MAX_RECORDS) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'snapshot_truncated',
        source: 'uk-companies',
        fetched: records.length,
        cap: MAX_RECORDS,
      }),
    );
  }
  return records.slice(0, MAX_RECORDS);
}

export const ukCompaniesSource: DataSource<UkCompaniesRecord> = {
  slug: 'uk-companies',
  title: 'UK new company incorporations',
  description:
    'The newest companies on the UK register, from the official Companies House API — name, number, type, SIC codes, incorporation date, and registered-office area, refreshed daily. Blind Mode: company-level fields only; officer and PSC data are never ingested, and address lines are dropped in favour of locality/postcode.',
  stats: {
    date: { field: 'incorporated_on', title: 'Incorporations by month' },
    groupBy: [
      { field: 'company_type', title: 'By company type' },
      { field: 'locality', title: 'Most active locations' },
    ],
  },
  recordSchema: ukCompaniesRecordSchema,
  queryParams: z.object({
    company: z.string().optional(),
    company_number: z.string().optional(),
    status: z.string().optional(),
    company_type: z.string().optional(),
    sic_codes: z.string().optional(),
    locality: z.string().optional(),
    postal_code: z.string().optional(),
    incorporated_on_after: z.iso.date().optional(),
    incorporated_on_before: z.iso.date().optional(),
  }),
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
  fetchFresh: async (env) => {
    try {
      // String() so the check survives the generated literal binding type.
      const key = String(env.COMPANIES_HOUSE_API_KEY ?? '');
      if (key === '') throw new Error('COMPANIES_HOUSE_API_KEY not configured');
      return await fetchFromOrigin(key);
    } catch (err) {
      if (String(env.FIXTURE_FALLBACK) === 'true') {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'fixture_fallback',
            source: 'uk-companies',
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return mapItems(fixtureItems);
      }
      throw err;
    }
  },
};
