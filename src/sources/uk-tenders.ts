import { z } from 'zod';
import fixtureReleases from './fixtures/uk-tenders.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// Origin (verified 2026-07-06):
//   GET https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?limit=100
//   → OCDS release package { releases: [...], links: { next? } } — cursor
//   pagination via links.next. Open Government Licence (Cabinet Office).
// Releases nest tender.*, buyer, parties[]; parties carry contactPoint
// emails/phones, so flattening whitelists org-level fields only (Blind Mode) —
// parties are never copied. Dates carry UTC offsets; range filters compare
// lexicographically, which is exact for same-offset values and date-precision
// queries (fine for v1).
const ORIGIN_URL = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const PAGE_SIZE = 100;
// Snapshot cap, same rationale as uk-planning (KV value limits, Worker memory).
const MAX_RECORDS = 1000;
// 429 back-off (2026-10-09, queue `uk-tenders-429-backoff`): Find a Tender throttled the 10-08
// wave (first time) and fetchFromOrigin threw on the first non-OK page. Same loop as eu-ted:
// up to RETRIES retries, pausing Retry-After when it is under the cap, else delayMs × attempt —
// ≤ 2 min worst case inside wave 1's budget. A page still throttled afterwards fails as before.
const RETRIES = 3;
export const tendersRetry = { delayMs: 20_000, maxRetryAfterMs: 120_000 };

async function fetchPage(url: string): Promise<Response> {
  const get = (): Promise<Response> =>
    originFetch(url, { headers: { accept: 'application/json' } });
  let res = await get();
  for (let attempt = 1; res.status === 429 && attempt <= RETRIES; attempt += 1) {
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const pause =
      retryAfter > 0 && retryAfter <= tendersRetry.maxRetryAfterMs
        ? retryAfter
        : tendersRetry.delayMs * attempt;
    await new Promise((resolve) => setTimeout(resolve, pause));
    res = await get();
  }
  return res;
}

const rawReleaseSchema = z.object({
  id: z.string(),
  ocid: z.string(),
  date: z.string().default(''),
  buyer: z.object({ name: z.string() }).nullish(),
  tender: z
    .object({
      title: z.string().nullish(),
      description: z.string().nullish(),
      status: z.string().nullish(),
      procurementMethod: z.string().nullish(),
      mainProcurementCategory: z.string().nullish(),
      value: z.object({ amount: z.number(), currency: z.string().nullish() }).nullish(),
      tenderPeriod: z.object({ endDate: z.string().nullish() }).nullish(),
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
});

const packageSchema = z.object({
  releases: z.array(z.unknown()),
  links: z.object({ next: z.string().nullish() }).nullish(),
});

export const ukTendersRecordSchema = z.object({
  ocid: z.string(),
  notice_id: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  buyer: z.string().nullable(),
  status: z.string().nullable(),
  procurement_method: z.string().nullable(),
  category: z.string().nullable(),
  cpv_codes: z.array(z.string()),
  value_amount: z.number().nullable(),
  value_currency: z.string().nullable(),
  published_at: z.string().nullable(),
  deadline_at: z.string().nullable(),
});

export type UkTendersRecord = z.infer<typeof ukTendersRecordSchema>;

function normalize(raw: z.infer<typeof rawReleaseSchema>): UkTendersRecord {
  const tender = raw.tender ?? undefined;
  const cpv = new Set<string>();
  for (const item of tender?.items ?? []) {
    if (item.classification?.id) cpv.add(item.classification.id);
    for (const extra of item.additionalClassifications ?? []) cpv.add(extra.id);
  }
  return {
    ocid: raw.ocid,
    notice_id: raw.id,
    title: tender?.title ?? null,
    description: tender?.description ?? null,
    buyer: raw.buyer?.name ?? null,
    status: tender?.status ?? null,
    procurement_method: tender?.procurementMethod ?? null,
    category: tender?.mainProcurementCategory ?? null,
    cpv_codes: [...cpv],
    value_amount: tender?.value?.amount ?? null,
    value_currency: tender?.value?.currency ?? null,
    published_at: raw.date === '' ? null : raw.date,
    deadline_at: tender?.tenderPeriod?.endDate ?? null,
  };
}

function mapReleases(releases: unknown[]): UkTendersRecord[] {
  const records: UkTendersRecord[] = [];
  for (const release of releases) {
    const parsed = rawReleaseSchema.safeParse(release);
    if (parsed.success) records.push(normalize(parsed.data));
  }
  return records;
}

async function fetchFromOrigin(): Promise<UkTendersRecord[]> {
  const records: UkTendersRecord[] = [];
  let url = `${ORIGIN_URL}?limit=${PAGE_SIZE}`;
  for (;;) {
    const res = await fetchPage(url);
    if (!res.ok) throw new Error(`find-tender.service.gov.uk responded ${res.status}`);
    const page = packageSchema.parse(await res.json());
    records.push(...mapReleases(page.releases));
    let next = page.links?.next;
    // Only follow pagination that stays on the official origin host — a
    // compromised/MITM'd feed can't redirect our crawler to an arbitrary host.
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
            source: 'uk-tenders',
            fetched: records.length,
          }),
        );
      }
      return records;
    }
    url = next;
  }
}

export const ukTendersSource: DataSource<UkTendersRecord> = {
  slug: 'uk-tenders',
  title: 'UK procurement notices',
  description:
    'Public procurement notices from the official Find a Tender OCDS feed, flattened to one queryable schema. Blind Mode: no contact or personal data.',
  stats: {
    date: { field: 'published_at', title: 'Notices published by month' },
    groupBy: [
      { field: 'buyer', title: 'Most active buyers' },
      { field: 'status', title: 'Notices by status' },
      { field: 'procurement_method', title: 'By procurement method' },
    ],
  },
  recordSchema: ukTendersRecordSchema,
  queryParams: z.object({
    buyer: z.string().optional(),
    status: z.string().optional(),
    procurement_method: z.string().optional(),
    cpv_codes: z.string().optional(),
    value_amount_min: z.coerce.number().optional(),
    value_amount_max: z.coerce.number().optional(),
    published_at_after: z.iso.date().optional(),
    published_at_before: z.iso.date().optional(),
  }),
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
  fetchFresh: async (env) => {
    try {
      return await fetchFromOrigin();
    } catch (err) {
      // String() so the check survives the generated literal binding type
      // (prod pins FIXTURE_FALLBACK="false"); local dev / tests set "true".
      if (String(env.FIXTURE_FALLBACK) === 'true') {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'fixture_fallback',
            source: 'uk-tenders',
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return mapReleases(fixtureReleases);
      }
      throw err;
    }
  },
};
