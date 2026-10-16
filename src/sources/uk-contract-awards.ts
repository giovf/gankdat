import { z } from 'zod';
import fixtureReleases from './fixtures/uk-contract-awards.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// UK public-sector contract AWARDS with the winning suppliers, from Contracts
// Finder's open OCDS search API (Cabinet Office; task 53). Where uk-tenders is
// the pipeline of open opportunities (Find a Tender), this is who actually won
// what, for how much — the supplier index that Stotles/Tussell/Tracker sell.
//
// Origin (verified 2026-09-21):
//   GET https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search
//       ?stages=award&publishedFrom=<ISO>&limit=100[&cursor=…]
//   → OCDS release package; `license` in-band = OGL v3; links.next for paging.
// One record per award × supplier (a notice can award several suppliers).
// Blind Mode: parties[] carry contactPoint names/emails/phones — never copied;
// supplier identity is the organisation name + its registry id (GB-COH-… →
// company number).

const ORIGIN_URL = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
const PAGE_SIZE = 100;
const WINDOW_DAYS = 14;
// Snapshot cap (KV value + Worker memory); ~2 weeks of awards fits comfortably.
const MAX_RECORDS = 3000;
const DESCRIPTION_MAX = 400;
const RETRIES = 3;
const RETRY_DELAY_MS = 45_000;

const rawReleaseSchema = z.object({
  id: z.string(),
  ocid: z.string(),
  date: z.string().default(''),
  buyer: z.object({ id: z.string().nullish(), name: z.string() }).nullish(),
  tender: z
    .object({
      title: z.string().nullish(),
      description: z.string().nullish(),
      procurementMethod: z.string().nullish(),
      mainProcurementCategory: z.string().nullish(),
      classification: z.object({ id: z.coerce.string().nullish() }).nullish(),
      items: z
        .array(
          z.object({
            classification: z.object({ id: z.coerce.string() }).nullish(),
            additionalClassifications: z.array(z.object({ id: z.coerce.string() })).nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
  awards: z
    .array(
      z.object({
        id: z.string().nullish(),
        status: z.string().nullish(),
        date: z.string().nullish(),
        value: z.object({ amount: z.number().nullish(), currency: z.string().nullish() }).nullish(),
        suppliers: z.array(z.object({ id: z.string().nullish(), name: z.string() })).nullish(),
        contractPeriod: z
          .object({ startDate: z.string().nullish(), endDate: z.string().nullish() })
          .nullish(),
      }),
    )
    .nullish(),
});

const packageSchema = z.object({
  releases: z.array(z.unknown()),
  links: z.object({ next: z.string().nullish() }).nullish(),
});

export const ukContractAwardsRecordSchema = z.object({
  ocid: z.string(),
  notice_id: z.string(),
  award_id: z.string().nullable(),
  title: z.string().nullable(),
  /** Tender description, capped at 400 characters. */
  description: z.string().nullable(),
  buyer: z.string().nullable(),
  buyer_id: z.string().nullable(),
  /** Winning supplier's organisation name. */
  supplier: z.string(),
  /** Supplier's OCDS party id as published, e.g. "GB-COH-10135058". */
  supplier_id: z.string().nullable(),
  /** UK company number when the supplier id is a Companies House id. */
  supplier_company_number: z.string().nullable(),
  award_status: z.string().nullable(),
  award_value_amount: z.number().nullable(),
  award_value_currency: z.string().nullable(),
  award_date: z.string().nullable(),
  contract_start: z.string().nullable(),
  contract_end: z.string().nullable(),
  cpv_codes: z.array(z.string()),
  category: z.string().nullable(),
  procurement_method: z.string().nullable(),
  published_at: z.string().nullable(),
});

export type UkContractAwardsRecord = z.infer<typeof ukContractAwardsRecordSchema>;

function companyNumber(partyId: string | null | undefined): string | null {
  const match = /^GB-COH-([A-Za-z0-9]{6,8})$/i.exec(partyId ?? '');
  return match ? match[1]!.toUpperCase().padStart(8, '0') : null;
}

function normalize(raw: z.infer<typeof rawReleaseSchema>): UkContractAwardsRecord[] {
  const tender = raw.tender ?? undefined;
  const cpv = new Set<string>();
  if (tender?.classification?.id) cpv.add(tender.classification.id);
  for (const item of tender?.items ?? []) {
    if (item.classification?.id) cpv.add(item.classification.id);
    for (const extra of item.additionalClassifications ?? []) cpv.add(extra.id);
  }
  const description = tender?.description?.trim() ?? '';
  const out: UkContractAwardsRecord[] = [];
  for (const award of raw.awards ?? []) {
    for (const supplier of award.suppliers ?? []) {
      out.push({
        ocid: raw.ocid,
        notice_id: raw.id,
        award_id: award.id ?? null,
        title: tender?.title ?? null,
        description: description === '' ? null : description.slice(0, DESCRIPTION_MAX),
        buyer: raw.buyer?.name ?? null,
        buyer_id: raw.buyer?.id ?? null,
        supplier: supplier.name,
        supplier_id: supplier.id ?? null,
        supplier_company_number: companyNumber(supplier.id),
        award_status: award.status ?? null,
        award_value_amount: award.value?.amount ?? null,
        award_value_currency: award.value?.currency ?? null,
        award_date: award.date ?? null,
        contract_start: award.contractPeriod?.startDate ?? null,
        contract_end: award.contractPeriod?.endDate ?? null,
        cpv_codes: [...cpv],
        category: tender?.mainProcurementCategory ?? null,
        procurement_method: tender?.procurementMethod ?? null,
        published_at: raw.date === '' ? null : raw.date,
      });
    }
  }
  return out;
}

function mapReleases(releases: unknown[]): UkContractAwardsRecord[] {
  const records: UkContractAwardsRecord[] = [];
  for (const release of releases) {
    const parsed = rawReleaseSchema.safeParse(release);
    if (parsed.success) records.push(...normalize(parsed.data));
  }
  return records;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19);
}

async function fetchFromOrigin(): Promise<UkContractAwardsRecord[]> {
  const records: UkContractAwardsRecord[] = [];
  let url = `${ORIGIN_URL}?stages=award&publishedFrom=${isoDaysAgo(WINDOW_DAYS)}&limit=${PAGE_SIZE}`;
  for (;;) {
    let res = await originFetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'gankdat.com data refresh' },
    });
    // Contracts Finder rate-limits bursts (429/403, seen at the 05:00 wave 2026-09-21):
    // back off and retry a few times before giving up on this refresh.
    for (
      let attempt = 1;
      (res.status === 429 || res.status === 403) && attempt <= RETRIES;
      attempt += 1
    ) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
      res = await originFetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'gankdat.com data refresh' },
      });
    }
    if (!res.ok) throw new Error(`contractsfinder.service.gov.uk responded ${res.status}`);
    const page = packageSchema.parse(await res.json());
    records.push(...mapReleases(page.releases));
    let next = page.links?.next;
    if (next) {
      try {
        if (new URL(next).host !== new URL(ORIGIN_URL).host) next = undefined;
      } catch {
        next = undefined;
      }
    }
    if (!next || page.releases.length === 0 || records.length >= MAX_RECORDS) {
      if (next && records.length >= MAX_RECORDS) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'snapshot_truncated',
            source: 'uk-contract-awards',
            fetched: records.length,
          }),
        );
      }
      return records;
    }
    url = next;
  }
}

export const ukContractAwardsSource: DataSource<UkContractAwardsRecord> = {
  slug: 'uk-contract-awards',
  title: 'UK contract awards (Contracts Finder)',
  description:
    'Who won which UK public-sector contract, for how much: award notices from the official Contracts Finder OCDS feed flattened to one row per award and supplier — buyer, supplier and its company number, award value and date, contract period, CPV codes, category and procurement method. Rolling window of the last two weeks of awards, refreshed daily. Organisation-level data only.',
  stats: {
    date: { field: 'published_at', title: 'Awards published by month' },
    groupBy: [
      { field: 'buyer', title: 'Most active buyers', limit: 15 },
      { field: 'supplier', title: 'Most awarded suppliers', limit: 15 },
      { field: 'category', title: 'By category' },
    ],
  },
  recordSchema: ukContractAwardsRecordSchema,
  queryParams: z.object({
    buyer: z.string().optional(),
    supplier: z.string().optional(),
    supplier_company_number: z.string().optional(),
    category: z.string().optional(),
    procurement_method: z.string().optional(),
    cpv_codes: z.string().optional(),
    award_value_amount_min: z.coerce.number().optional(),
    award_value_amount_max: z.coerce.number().optional(),
    award_date_after: z.string().optional(),
    award_date_before: z.string().optional(),
    published_at_after: z.string().optional(),
    published_at_before: z.string().optional(),
  }),
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
  async fetchFresh(env: CloudflareBindings): Promise<UkContractAwardsRecord[]> {
    try {
      return await fetchFromOrigin();
    } catch (err) {
      if (String(env.FIXTURE_FALLBACK) === 'true') {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'fixture_fallback',
            source: 'uk-contract-awards',
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return mapReleases(fixtureReleases as unknown[]);
      }
      throw err;
    }
  },
};
