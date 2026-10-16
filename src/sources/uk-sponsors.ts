import { z } from 'zod';
import { csvRows } from './csv';
import fixtureRecords from './fixtures/uk-sponsors.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// UK register of licensed sponsors (Worker and Temporary Worker routes) — every
// organisation the Home Office licenses to sponsor visa workers, from the
// official GOV.UK publication (task 48).
//
// Ingest: GOV.UK republishes a single CSV (~11MB, ~143k rows: one row per
// organisation × route) most working days, under a URL that changes with each
// publication. The GOV.UK Content API for the publication page lists the
// current attachment, so the refresh resolves the URL first, then streams the
// CSV into D1 (storage:'d1' + fetchStream). OGL v3. Organisation-level data
// only — no personal data by construction.

const CONTENT_API_URL =
  'https://www.gov.uk/api/content/government/publications/register-of-licensed-sponsors-workers';
const ASSET_HOST = /(^|\.)(publishing\.service\.gov\.uk|gov\.uk)$/;
const USER_AGENT = 'gankdat.com data refresh';
const MAX_BYTES = 128 * 1024 * 1024;

export const ukSponsorsRecordSchema = z.object({
  /** Organisation name as licensed (trimmed; the register is not consistently cased). */
  organisation: z.string(),
  town: z.string().nullable(),
  county: z.string().nullable(),
  /** "Worker" or "Temporary Worker". */
  sponsor_type: z.string(),
  /** "A", "B", "A (Premium)", "A (SME+)", "Provisional" (UK Expansion Worker) or as published. */
  rating: z.string().nullable(),
  /** Immigration route the licence covers, e.g. "Skilled Worker", "Global Business Mobility: Senior or Specialist Worker". */
  route: z.string(),
});

export type UkSponsorsRecord = z.infer<typeof ukSponsorsRecordSchema>;

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed === '' ? null : trimmed;
}

/** "Worker (A rating)" → { type: "Worker", rating: "A" }; "Worker (UK Expansion Worker: Provisional )" → rating "Provisional". */
function splitTypeRating(raw: string | null): { type: string; rating: string | null } | null {
  if (raw === null) return null;
  const match = /^(.*?)\s*\((.*)\)\s*$/.exec(raw);
  if (!match) return { type: raw, rating: null };
  const type = match[1]!.trim();
  let rating = match[2]!.trim().replace(/\s+rating$/i, '');
  const provisional = /provisional/i.exec(rating);
  if (provisional) rating = 'Provisional';
  return { type, rating: rating === '' ? null : rating };
}

const REQUIRED_COLUMNS = [
  'Organisation Name',
  'Town/City',
  'County',
  'Type & Rating',
  'Route',
] as const;

function normalizeRow(cols: string[], idx: Map<string, number>): UkSponsorsRecord | null {
  const col = (name: string): string | null => clean(cols[idx.get(name) ?? -1]);
  const organisation = col('Organisation Name');
  const route = col('Route');
  const tr = splitTypeRating(col('Type & Rating'));
  if (organisation === null || route === null || tr === null) return null;
  return {
    organisation,
    town: col('Town/City'),
    county: col('County'),
    sponsor_type: tr.type,
    rating: tr.rating,
    route,
  };
}

interface ContentApiResponse {
  details?: { attachments?: { url?: string; content_type?: string; title?: string }[] };
}

/** Current CSV attachment URL from the GOV.UK Content API (the asset URL changes per publication). */
async function currentCsvUrl(): Promise<string> {
  const res = await originFetch(CONTENT_API_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`GOV.UK content API failed: ${res.status}`);
  const body = (await res.json()) as ContentApiResponse;
  const attachment = (body.details?.attachments ?? []).find(
    (a) => (a.content_type ?? '').includes('csv') || /\.csv$/i.test(a.url ?? ''),
  );
  if (!attachment?.url) throw new Error('GOV.UK publication has no CSV attachment');
  const url = new URL(attachment.url, 'https://www.gov.uk');
  if (url.protocol !== 'https:' || !ASSET_HOST.test(url.hostname)) {
    throw new Error(`sponsor register attachment on unexpected host (${url.hostname})`);
  }
  return url.toString();
}

/** Caps the total bytes read from a stream, aborting past the limit. */
function byteCapTransform(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > limit) {
        controller.error(new Error(`sponsor register exceeded ${limit} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

async function* streamFromOrigin(): AsyncGenerator<UkSponsorsRecord> {
  const csvUrl = await currentCsvUrl();
  const res = await originFetch(csvUrl, { headers: { 'user-agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`sponsor register download failed: ${res.status}`);
  let idx: Map<string, number> | null = null;
  let yielded = 0;
  for await (const row of csvRows(res.body.pipeThrough(byteCapTransform(MAX_BYTES)))) {
    if (idx === null) {
      idx = new Map(row.map((column, i) => [column.replace(/^\uFEFF/, '').trim(), i]));
      const missing = REQUIRED_COLUMNS.filter((column) => !idx!.has(column));
      if (missing.length > 0) {
        throw new Error(`sponsor register format changed — missing: ${missing.join(', ')}`);
      }
      continue;
    }
    const record = normalizeRow(row, idx);
    if (record) {
      yielded += 1;
      yield record;
    }
  }
  if (yielded === 0) throw new Error('sponsor register parsed 0 records');
}

function fixtures(): UkSponsorsRecord[] {
  return z.array(ukSponsorsRecordSchema).parse(fixtureRecords);
}

async function* fetchStream(env: CloudflareBindings): AsyncIterable<UkSponsorsRecord> {
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
          source: 'uk-sponsors',
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
      yield* fixtures();
      return;
    }
    throw err;
  }
}

export const ukSponsorsSource: DataSource<UkSponsorsRecord> = {
  slug: 'uk-sponsors',
  title: 'UK licensed visa sponsors (Home Office)',
  description:
    'Every organisation on the Home Office register of licensed sponsors for Worker and Temporary Worker visa routes — organisation name, town and county, sponsor type, licence rating, and the immigration route (Skilled Worker, Global Business Mobility, Creative Worker, and more). One row per organisation and route, from the official GOV.UK publication, refreshed on every republication (most working days). Organisation-level data only.',
  storage: 'd1',
  // No date field in the register, so no stats spec: /stats/uk-sponsors shows count + freshness.
  recordSchema: ukSponsorsRecordSchema,
  queryParams: z.object({
    organisation: z.string().optional(),
    town: z.string().optional(),
    county: z.string().optional(),
    sponsor_type: z.string().optional(),
    rating: z.string().optional(),
    route: z.string().optional(),
  }),
  refresh: { cron: '15 5 * * *', cacheTtlSeconds: 86_400 },
  // No published id: organisation × town × route is the row's identity in the register.
  idOf: (r) => [r.organisation, r.town ?? '', r.route].join('|').toLowerCase(),
  fetchStream,
  async fetchFresh(env: CloudflareBindings): Promise<UkSponsorsRecord[]> {
    const records: UkSponsorsRecord[] = [];
    for await (const record of fetchStream(env)) records.push(record);
    return records;
  },
};
