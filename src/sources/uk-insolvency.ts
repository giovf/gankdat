import { z } from 'zod';
import fixtureEntries from './fixtures/uk-insolvency.json';
import type { DataSource } from './types';
import { OriginUnavailableError, originFetch } from './origin';

// The Gazette — corporate insolvency notices (task 41). Official public
// record, Crown copyright, OGL v3; the OGL grant EXCLUDES personal data, so
// this source is the corporate-only slice with a STRICT structured-field
// whitelist: entry id, title (company name), notice code, category, dates.
// The feed's person fields (f:name / f:familyName) and the free-text content
// HTML (which names insolvency practitioners) are never read — Blind Mode.
//
// Notice-code whitelist verified live 2026-07-13 (per-code category probe):
// the 24xx block is corporate insolvency (moratoria, administrators,
// receivers, liquidators, winding-up, dividends). Excluded: 2403 "Re-use of
// a Prohibited Name" (notice titles are PERSONS, fails Blind Mode) and
// 2437/2440/2448 (no category name published; unverifiable). Personal
// insolvency (25xx bankruptcy, 29xx) is out of scope by design.
//
// Fair-use policy (thegazette.co.uk/data): max 5 requests / 10 seconds and
// an identifiable User-Agent — pages are fetched sequentially with a pacing
// delay, ~10 requests per daily refresh.
const ORIGIN_URL = 'https://www.thegazette.co.uk/insolvency/notice/data.json';
const CORPORATE_NOTICE_CODES = [
  2401, 2402, 2404, 2405, 2406, 2407, 2408, 2409, 2410, 2411, 2412, 2413, 2414, 2421, 2422, 2423,
  2431, 2432, 2433, 2434, 2435, 2441, 2442, 2443, 2444, 2445, 2446, 2447, 2450, 2451, 2452, 2453,
  2454, 2455, 2456, 2457, 2458, 2459, 2460, 2461, 2462, 2463, 2464, 2465,
];
// The Blind-Mode guarantee (never serve a person-named notice) must not rest on
// the origin honouring our ?noticetypes filter — if The Gazette ever changed
// that param's meaning or fell back to "all notices", personal-insolvency
// titles (which ARE people's names) would flow straight through. So we re-check
// every returned notice code against this set at ingest and drop the rest.
const CORPORATE_CODE_SET = new Set(CORPORATE_NOTICE_CODES.map(String));
const CORPORATE_NOTICE_PARAM = CORPORATE_NOTICE_CODES.join(',');
// 50, not 100: a 100-notice page is ~204 KB (relay check 2026-09-30) and the Worker read it as
// 0 bytes on 2026-09-28 and 09-30 while a runner got the full body — the origin cutting a long
// response, so half the bytes per request and twice the requests (20 for the snapshot, still
// paced within the fair-use limit and well inside the wave budget).
const PAGE_SIZE = 50;
// Snapshot cap (KV window, same rationale as uk-tenders): the product is the
// freshest corporate-insolvency events, newest-first as the feed returns them.
const MAX_RECORDS = 1000;
const PAGE_DELAY_MS = 2_100;

const categoryShape = z.object({ '@term': z.string().nullish() });
const rawEntrySchema = z.object({
  id: z.string(),
  'f:notice-code': z.coerce.string().nullish(),
  title: z.string().nullish(),
  published: z.string().nullish(),
  updated: z.string().nullish(),
  category: z.union([categoryShape, z.array(categoryShape)]).nullish(),
});

const feedSchema = z.object({
  'f:total': z.coerce.number().nullish(),
  entry: z.union([z.array(z.unknown()), z.unknown()]).nullish(),
});

export const ukInsolvencyRecordSchema = z.object({
  notice_id: z.string(),
  /** Company name as published in the notice title. */
  company: z.string().nullable(),
  notice_code: z.string().nullable(),
  /** Category name, e.g. "Petitions to Wind Up (Companies)". */
  notice_type: z.string().nullable(),
  published_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  notice_url: z.string(),
});

export type UkInsolvencyRecord = z.infer<typeof ukInsolvencyRecordSchema>;

function categoryTerm(raw: z.infer<typeof rawEntrySchema>['category']): string | null {
  if (!raw) return null;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.['@term'] ?? null;
}

function normalize(raw: z.infer<typeof rawEntrySchema>): UkInsolvencyRecord {
  const noticeId = raw.id.slice(raw.id.lastIndexOf('/') + 1);
  return {
    notice_id: noticeId,
    company: raw.title ?? null,
    notice_code: raw['f:notice-code'] ?? null,
    notice_type: categoryTerm(raw.category),
    published_at: raw.published ?? null,
    updated_at: raw.updated ?? null,
    notice_url: `https://www.thegazette.co.uk/notice/${noticeId}`,
  };
}

function mapEntries(entries: unknown[]): UkInsolvencyRecord[] {
  const records: UkInsolvencyRecord[] = [];
  let dropped = 0;
  for (const entry of entries) {
    const parsed = rawEntrySchema.safeParse(entry);
    if (!parsed.success) continue;
    // Defence in depth: only ingest notices whose code is a known corporate
    // type. A non-corporate notice slipping through the origin filter would
    // carry a person's name in `title` — drop it rather than serve it.
    const code = parsed.data['f:notice-code'];
    if (code === null || code === undefined || !CORPORATE_CODE_SET.has(code)) {
      dropped += 1;
      continue;
    }
    records.push(normalize(parsed.data));
  }
  if (dropped > 0) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'non_corporate_notice_dropped',
        source: 'uk-insolvency',
        dropped,
      }),
    );
  }
  return records;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A cut body (empty, shorter than its content-length, or unparsable) is retried like a 5xx —
// four reads, each after a longer fair-use pause. 2026-09-28 and 09-30 the Worker read page 1 as
// 0 bytes three times in a row within ~6 s while a GitHub runner got the full 204 KB, so the cut
// is momentary and on the origin's side; the pauses now span ~13 s.
const FETCH_ATTEMPTS = 4;
// A 5xx is retried like a cut body — four reads over ~13 s of growing fair-use pauses. It was
// one retry after 2.1 s ("thegazette.co.uk responded 500" cost the 2026-09-29 wave-1 refresh
// its day); on 2026-10-10 13:00 the runner read 503 twice 3 s apart and lost the day, while the
// next run read the feed in full. A 5xx that outlasts the four reads is the origin's fault for
// the day, not the parser's: it is thrown as OriginUnavailableError so the runner logs the
// refresh as `skipped` and the last snapshot stays served without an error row.
const SERVER_ERROR_ATTEMPTS = 4;
const ORIGIN_HOST = 'thegazette.co.uk';

/** A body the origin cut: nothing, or fewer bytes than it declared. */
function shortBody(text: string, declared: string | null): boolean {
  if (text.length === 0) return true;
  const length = Number(declared);
  return Number.isFinite(length) && length > 0 && new TextEncoder().encode(text).length < length;
}

// 4xx and network errors are not retried here (they fall back to fixtures as before).
async function fetchJsonWithRetry(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    const res = await originFetch(url, {
      headers: { 'user-agent': 'gankdat.com data refresh (info@gankdat.com)' },
    });
    if (!res.ok) {
      if (res.status >= 500) {
        if (attempt < SERVER_ERROR_ATTEMPTS) {
          await sleep(PAGE_DELAY_MS * attempt);
          continue;
        }
        throw new OriginUnavailableError(ORIGIN_HOST, res.status, attempt);
      }
      throw new Error(`${ORIGIN_HOST} responded ${res.status}`);
    }
    // Read the bytes first so a truncated body fails with evidence (bytes seen vs the
    // declared length, and the tail) — three refreshes failed on "Unexpected end of JSON
    // input" alone in the week to 2026-09-28, which says nothing about where the cut is.
    const text = await res.text();
    const declared = res.headers.get('content-length');
    try {
      if (shortBody(text, declared)) throw new Error('body cut by the origin');
      return JSON.parse(text) as unknown;
    } catch (err) {
      if (attempt >= FETCH_ATTEMPTS) {
        const tail = text.slice(-40).replaceAll(/\s+/g, ' ');
        throw new Error(
          `thegazette.co.uk page ${url.slice(url.indexOf('results-page='))}: ${err instanceof Error ? err.message : String(err)} after ${attempt} reads (${text.length} bytes, content-length ${declared ?? '?'}, tail "${tail}")`,
          { cause: err },
        );
      }
      await sleep(PAGE_DELAY_MS * attempt);
    }
  }
}

async function fetchFromOrigin(): Promise<UkInsolvencyRecord[]> {
  const records: UkInsolvencyRecord[] = [];
  const pages = Math.ceil(MAX_RECORDS / PAGE_SIZE);
  for (let page = 1; page <= pages; page += 1) {
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const url = `${ORIGIN_URL}?noticetypes=${CORPORATE_NOTICE_PARAM}&results-page-size=${PAGE_SIZE}&results-page=${page}`;
    // No accept header: the Gazette's content negotiation 500s when one is
    // sent alongside the .json path (verified 2026-07-13); the extension
    // alone selects the format.
    let feed: z.infer<typeof feedSchema>;
    try {
      feed = feedSchema.parse(await fetchJsonWithRetry(url));
    } catch (err) {
      // A later page that never arrives must not cost the day: the pages already read are
      // the newest notices (the feed is newest-first), which is the product. Keep them and
      // say so; only page 1 failing is a failed refresh (the previous snapshot then stays).
      if (records.length === 0) throw err;
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'partial_snapshot',
          source: 'uk-insolvency',
          pages_read: page - 1,
          records: records.length,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      break;
    }
    const entries =
      feed.entry === undefined || feed.entry === null
        ? []
        : Array.isArray(feed.entry)
          ? feed.entry
          : [feed.entry];
    records.push(...mapEntries(entries));
    if (entries.length < PAGE_SIZE) break;
  }
  return records.slice(0, MAX_RECORDS);
}

export const ukInsolvencySource: DataSource<UkInsolvencyRecord> = {
  slug: 'uk-insolvency',
  title: 'UK corporate insolvency notices',
  description:
    'The latest corporate insolvency notices from The Gazette (official UK public record) — winding-up petitions and orders, administrator, receiver and liquidator appointments, moratoria, and creditor notices, company-level facts only. Blind Mode: person fields and notice text in the source are never ingested.',
  stats: {
    date: { field: 'published_at', title: 'Notices published by month' },
    groupBy: [
      { field: 'notice_type', title: 'By notice type' },
      { field: 'notice_code', title: 'By notice code' },
    ],
  },
  recordSchema: ukInsolvencyRecordSchema,
  queryParams: z.object({
    company: z.string().optional(),
    notice_type: z.string().optional(),
    notice_code: z.string().optional(),
    published_at_after: z.iso.date().optional(),
    published_at_before: z.iso.date().optional(),
  }),
  // Runner-fed since 2026-10-04: from 2026-09-28 every Worker read of page 1 came back as 0
  // bytes (four paced reads a day, page size halved on 09-30, still nothing) while a GitHub
  // runner read the same URL in full each time — the origin cuts the body for the Worker's
  // egress, not for the layout. The cron waves skip this source; the `gankdat metrics` job
  // runs `fetchFresh` below on its runner and writes the KV snapshot and refresh_log row.
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400, runner: true },
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
            source: 'uk-insolvency',
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return mapEntries(fixtureEntries);
      }
      throw err;
    }
  },
};
