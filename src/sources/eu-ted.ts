import { z } from 'zod';
import fixtureNotices from './fixtures/eu-ted.json';
import type { DataSource } from './types';

// Origin (verified 2026-07-12, docs.ted.europa.eu/api):
//   POST https://api.ted.europa.eu/v3/notices/search
//   body { query, fields, limit ≤ 250, page } → { notices: [...], totalNoticeCount }
//   No API key; new OJ S edition every weekday by 09:00 CET. Licence:
//   Commission Decision 2011/833/EU — free commercial reuse with attribution.
// Fields are requested as an explicit whitelist of organisation-level eForms
// values (Blind Mode: buyer contact persons/emails exist only in the full
// notice XML, which we never fetch). Titles and buyer names arrive as
// language-keyed maps — we prefer English and fall back to the original
// language. The window query is server-relative (today(-N)), sorted newest
// first so the snapshot cap keeps the freshest notices.
const ORIGIN_URL = 'https://api.ted.europa.eu/v3/notices/search';
const PAGE_SIZE = 250;
// Snapshot cap, same rationale as uk-planning/uk-tenders (KV value limits,
// Worker memory). TED publishes 2-3k notices per weekday, so this holds
// roughly the latest half-day of EU-wide activity.
const MAX_RECORDS = 1000;
const WINDOW_QUERY = 'publication-date>=today(-3) SORT BY publication-number DESC';
/**
 * TED throttles bursts (429 on 2026-10-01 and 10-06, each costing the day's refresh until a
 * request-path retry hours later — queue `eu-ted-429-backoff`): a 429 page is retried a few
 * times with a growing pause, honouring Retry-After when it is short enough, inside wave 1's
 * budget. `delayMs` is a mutable so tests run the loop without waiting.
 */
const RETRIES = 3;
export const tedRetry = { delayMs: 20_000, maxRetryAfterMs: 120_000 };
const FIELDS = [
  'publication-number',
  'publication-date',
  'notice-title',
  'notice-type',
  'buyer-name',
  'buyer-country',
  'classification-cpv',
  'contract-nature-main-proc',
  'procedure-type',
  'estimated-value-proc',
  'estimated-value-cur-proc',
  'deadline-receipt-tender-date-lot',
  'place-of-performance',
] as const;

const rawNoticeSchema = z.object({
  'publication-number': z.string(),
  'publication-date': z.string().nullish(),
  'notice-title': z.record(z.string(), z.string()).nullish(),
  'notice-type': z.string().nullish(),
  'buyer-name': z.record(z.string(), z.array(z.string())).nullish(),
  'buyer-country': z.array(z.string()).nullish(),
  'classification-cpv': z.array(z.coerce.string()).nullish(),
  'contract-nature-main-proc': z.string().nullish(),
  'procedure-type': z.string().nullish(),
  'estimated-value-proc': z.coerce.number().nullish(),
  'estimated-value-cur-proc': z.string().nullish(),
  'deadline-receipt-tender-date-lot': z.array(z.string()).nullish(),
  'place-of-performance': z.array(z.string()).nullish(),
});

const searchResponseSchema = z.object({
  notices: z.array(z.unknown()),
});

export const euTedRecordSchema = z.object({
  publication_number: z.string(),
  title: z.string().nullable(),
  buyer: z.string().nullable(),
  buyer_country: z.string().nullable(),
  notice_type: z.string().nullable(),
  procedure_type: z.string().nullable(),
  contract_nature: z.string().nullable(),
  cpv_codes: z.array(z.string()),
  places_of_performance: z.array(z.string()),
  value_amount: z.number().nullable(),
  value_currency: z.string().nullable(),
  published_at: z.string().nullable(),
  deadline_at: z.string().nullable(),
  notice_url: z.string(),
});

export type EuTedRecord = z.infer<typeof euTedRecordSchema>;

/** Language-keyed eForms value → English if present, else the first language. */
function pickLanguage<T>(map: Record<string, T> | null | undefined): T | null {
  if (!map) return null;
  if (map.eng !== undefined) return map.eng;
  for (const value of Object.values(map)) return value;
  return null;
}

/** TED date values carry a bare offset ("2026-07-10+02:00") → "2026-07-10". */
function isoDate(raw: string | null | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw ?? '');
  return match ? match[1] : null;
}

function normalize(raw: z.infer<typeof rawNoticeSchema>): EuTedRecord {
  const deadlines = (raw['deadline-receipt-tender-date-lot'] ?? [])
    .map(isoDate)
    .filter((d): d is string => d !== null)
    .sort();
  const value = raw['estimated-value-proc'];
  return {
    publication_number: raw['publication-number'],
    title: pickLanguage(raw['notice-title']),
    buyer: pickLanguage(raw['buyer-name'])?.[0] ?? null,
    buyer_country: raw['buyer-country']?.[0] ?? null,
    notice_type: raw['notice-type'] ?? null,
    procedure_type: raw['procedure-type'] ?? null,
    contract_nature: raw['contract-nature-main-proc'] ?? null,
    cpv_codes: [...new Set(raw['classification-cpv'] ?? [])],
    places_of_performance: [...new Set(raw['place-of-performance'] ?? [])],
    value_amount: typeof value === 'number' && Number.isFinite(value) ? value : null,
    value_currency: raw['estimated-value-cur-proc'] ?? null,
    published_at: isoDate(raw['publication-date']),
    deadline_at: deadlines[0] ?? null,
    notice_url: `https://ted.europa.eu/en/notice/-/detail/${raw['publication-number']}`,
  };
}

function mapNotices(notices: unknown[]): EuTedRecord[] {
  const records: EuTedRecord[] = [];
  for (const notice of notices) {
    const parsed = rawNoticeSchema.safeParse(notice);
    if (parsed.success) records.push(normalize(parsed.data));
  }
  return records;
}

async function fetchPage(page: number): Promise<Response> {
  const post = (): Promise<Response> =>
    fetch(ORIGIN_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'gankdat.com data refresh',
      },
      body: JSON.stringify({ query: WINDOW_QUERY, fields: FIELDS, limit: PAGE_SIZE, page }),
    });
  let res = await post();
  for (let attempt = 1; res.status === 429 && attempt <= RETRIES; attempt += 1) {
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    const pause =
      retryAfter > 0 && retryAfter <= tedRetry.maxRetryAfterMs
        ? retryAfter
        : tedRetry.delayMs * attempt;
    await new Promise((resolve) => setTimeout(resolve, pause));
    res = await post();
  }
  return res;
}

async function fetchFromOrigin(): Promise<EuTedRecord[]> {
  const records: EuTedRecord[] = [];
  // Hard page cap: reaching MAX_RECORDS needs a handful of pages; this bounds
  // the loop even if the origin returns full pages whose notices all fail to
  // parse (schema drift), which would otherwise never grow `records`.
  const maxPages = Math.ceil(MAX_RECORDS / PAGE_SIZE) + 1;
  for (let page = 1; records.length < MAX_RECORDS && page <= maxPages; page += 1) {
    const res = await fetchPage(page);
    if (!res.ok) throw new Error(`api.ted.europa.eu responded ${res.status}`);
    const { notices } = searchResponseSchema.parse(await res.json());
    records.push(...mapNotices(notices));
    if (notices.length < PAGE_SIZE) return records;
  }
  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'snapshot_truncated',
      source: 'eu-ted',
      fetched: records.length,
    }),
  );
  return records.slice(0, MAX_RECORDS);
}

export const euTedSource: DataSource<EuTedRecord> = {
  slug: 'eu-ted',
  title: 'EU procurement notices (TED)',
  description:
    'Contract notices and awards from TED (Tenders Electronic Daily), the official EU procurement journal — buyer, country, CPV codes, values, and deadlines across all member states, normalized for bid intelligence. Blind Mode: only organisation-level fields are ingested.',
  stats: {
    date: { field: 'published_at', title: 'Notices published by month' },
    groupBy: [
      { field: 'buyer_country', title: 'Notices by buyer country' },
      { field: 'contract_nature', title: 'By contract nature' },
      { field: 'procedure_type', title: 'By procedure type' },
    ],
  },
  recordSchema: euTedRecordSchema,
  queryParams: z.object({
    buyer: z.string().optional(),
    buyer_country: z.string().optional(),
    notice_type: z.string().optional(),
    procedure_type: z.string().optional(),
    contract_nature: z.string().optional(),
    cpv_codes: z.string().optional(),
    places_of_performance: z.string().optional(),
    value_amount_min: z.coerce.number().optional(),
    value_amount_max: z.coerce.number().optional(),
    published_at_after: z.iso.date().optional(),
    published_at_before: z.iso.date().optional(),
    deadline_at_after: z.iso.date().optional(),
    deadline_at_before: z.iso.date().optional(),
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
            source: 'eu-ted',
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return mapNotices(fixtureNotices);
      }
      throw err;
    }
  },
};
