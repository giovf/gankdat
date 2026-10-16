import { z } from 'zod';
import fixtureEntities from './fixtures/uk-planning.json';
import type { DataSource } from './types';
import { originFetch } from './origin';

// Origin (verified 2026-07-06):
//   GET https://www.planning.data.gov.uk/entity.json?dataset=planning-application&limit=500&offset=N
//   → { entities: [...], links: { first, last, next?, prev? }, count }
// Entity fields are hyphenated (entry-date, organisation-entity, decision-date, …),
// missing values are empty strings, `organisation-entity` is the numeric id of the
// local planning authority, `point` is WKT. Open Government Licence.
// 2026-10-10: the platform emptied the dataset — /dataset/planning-application.json reports
// entity-count 0, phase alpha, no replacement-dataset, every entity query answers count 0 and
// the bulk CSV is 403 (relay planning-origin-2026-10-11). A first page with count 0 is that
// state, named as such so the refresh row and the auto-filer read it (the generic guard would
// only say "refresh returned 0 records"); the last good snapshot stays served under NOTICE.
const ORIGIN_EMPTY_SINCE = '2026-10-10';
/** The platform's dataset is empty — a real state, never masked by the dev fixture fallback. */
class OriginEmptyError extends Error {}
const NOTICE = `Origin paused: planning.data.gov.uk emptied its planning-application dataset on ${ORIGIN_EMPTY_SINCE} (entity-count 0, phase alpha). The snapshot of 2026-10-09 is served unchanged until the platform republishes.`;
const ORIGIN_URL = 'https://www.planning.data.gov.uk/entity.json';
const PAGE_SIZE = 500;
// Snapshot cap: KV values max 25 MB and Worker memory is bounded; v1 serves the
// most recent slice of the dataset, not all ~100k records. Raised post-v1 when
// the cache layer shards per authority.
const MAX_RECORDS = 2000;

// Blind Mode (UK GDPR): only these whitelisted, non-personal fields survive
// ingest — z.object strips unknown keys, so applicant/agent/contact fields in
// origin data are dropped before anything is cached or stored.
const rawEntitySchema = z.object({
  entity: z.number(),
  reference: z.string(),
  'organisation-entity': z.coerce.number(),
  description: z.string().default(''),
  'decision-date': z.string().default(''),
  'entry-date': z.string().default(''),
  'start-date': z.string().default(''),
  'end-date': z.string().default(''),
  point: z.string().default(''),
});

const pageSchema = z.object({
  entities: z.array(z.unknown()),
  count: z.number(),
});

export const ukPlanningRecordSchema = z.object({
  entity: z.number(),
  reference: z.string(),
  authority: z.number(),
  description: z.string().nullable(),
  decision_date: z.string().nullable(),
  entry_date: z.string().nullable(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  point: z.string().nullable(),
});

export type UkPlanningRecord = z.infer<typeof ukPlanningRecordSchema>;

const emptyToNull = (value: string): string | null => (value === '' ? null : value);

function normalize(raw: z.infer<typeof rawEntitySchema>): UkPlanningRecord {
  return {
    entity: raw.entity,
    reference: raw.reference,
    authority: raw['organisation-entity'],
    description: emptyToNull(raw.description),
    decision_date: emptyToNull(raw['decision-date']),
    entry_date: emptyToNull(raw['entry-date']),
    start_date: emptyToNull(raw['start-date']),
    end_date: emptyToNull(raw['end-date']),
    point: emptyToNull(raw.point),
  };
}

function mapEntities(entities: unknown[]): UkPlanningRecord[] {
  const records: UkPlanningRecord[] = [];
  for (const entity of entities) {
    const parsed = rawEntitySchema.safeParse(entity);
    if (parsed.success) records.push(normalize(parsed.data));
  }
  return records;
}

async function fetchPage(offset: number): Promise<z.infer<typeof pageSchema>> {
  const url = `${ORIGIN_URL}?dataset=planning-application&limit=${PAGE_SIZE}&offset=${offset}`;
  const res = await originFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`planning.data.gov.uk responded ${res.status}`);
  return pageSchema.parse(await res.json());
}

async function fetchFromOrigin(): Promise<UkPlanningRecord[]> {
  const records: UkPlanningRecord[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset);
    if (offset === 0 && page.count === 0 && page.entities.length === 0) {
      throw new OriginEmptyError(
        `origin dataset empty: planning-application answered count 0 (emptied on planning.data.gov.uk since ${ORIGIN_EMPTY_SINCE}; the last snapshot is served)`,
      );
    }
    records.push(...mapEntities(page.entities));
    offset += PAGE_SIZE;
    if (page.entities.length === 0 || offset >= Math.min(page.count, MAX_RECORDS)) {
      if (page.count > MAX_RECORDS) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'snapshot_truncated',
            source: 'uk-planning',
            fetched: records.length,
            origin_count: page.count,
          }),
        );
      }
      return records;
    }
  }
}

export const ukPlanningSource: DataSource<UkPlanningRecord> = {
  slug: 'uk-planning',
  title: 'UK planning applications',
  description:
    'Planning applications from the official planning.data.gov.uk feed, normalized to one schema. Blind Mode: no applicant personal data.',
  notice: NOTICE,
  stats: {
    date: { field: 'entry_date', title: 'Applications recorded by month' },
    groupBy: [
      { field: 'authority', title: 'Most active planning authorities (organisation code)' },
    ],
  },
  recordSchema: ukPlanningRecordSchema,
  queryParams: z.object({
    reference: z.string().optional(),
    authority: z.coerce.number().optional(),
    decision_date_after: z.iso.date().optional(),
    decision_date_before: z.iso.date().optional(),
  }),
  refresh: { cron: '0 5 * * *', cacheTtlSeconds: 86_400 },
  fetchFresh: async (env) => {
    try {
      return await fetchFromOrigin();
    } catch (err) {
      // An emptied origin is the dataset's real state: fail so the last snapshot is served.
      if (err instanceof OriginEmptyError) throw err;
      // Offline-capable local dev only; production must fail loudly so the
      // refresh log shows it (FIXTURE_FALLBACK is unset in production).
      // String() so the check survives the generated literal binding type
      // (prod pins FIXTURE_FALLBACK="false"); local dev / tests set "true".
      if (String(env.FIXTURE_FALLBACK) === 'true') {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'fixture_fallback',
            source: 'uk-planning',
            reason: err instanceof Error ? err.message : String(err),
          }),
        );
        return mapEntities(fixtureEntities);
      }
      throw err;
    }
  },
};
