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
// (HTTP Basic, key as username; 600 requests / 5 min — refresh uses ~14).
const ORIGIN_URL = 'https://api.company-information.service.gov.uk/advanced-search/companies';
const PAGE_SIZE = 1000;
const WINDOW_DAYS = 7;
// Snapshot cap, same rationale as the other KV sources.
const MAX_RECORDS = 2000;

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
  // Hard page cap per day: reaching MAX_RECORDS needs only a couple of pages,
  // and this bounds the loop even if the origin returns full pages whose items
  // all fail to parse (schema drift) — without it, `records` never grows and
  // the loop would run to the Worker subrequest cap.
  const maxPagesPerDay = Math.ceil(MAX_RECORDS / PAGE_SIZE) + 1;
  for (let day = 0; day < WINDOW_DAYS && records.length < MAX_RECORDS; day += 1) {
    const date = isoDaysAgo(day);
    for (
      let startIndex = 0, pageNum = 0;
      records.length < MAX_RECORDS && pageNum < maxPagesPerDay;
      startIndex += PAGE_SIZE, pageNum += 1
    ) {
      const url = `${ORIGIN_URL}?incorporated_from=${date}&incorporated_to=${date}&size=${PAGE_SIZE}&start_index=${startIndex}`;
      const res = await originFetch(url, {
        headers: { authorization: auth, 'user-agent': 'gankdat.com data refresh' },
      });
      if (!res.ok) throw new Error(`company-information.service.gov.uk responded ${res.status}`);
      const page = searchSchema.parse(await res.json());
      const items = page.items ?? [];
      records.push(...mapItems(items));
      if (items.length < PAGE_SIZE) break;
    }
  }
  if (records.length >= MAX_RECORDS) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'snapshot_truncated',
        source: 'uk-companies',
        fetched: records.length,
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
