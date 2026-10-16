import type { z } from 'zod';

export interface RefreshPolicy {
  /**
   * Intended refresh cadence (advisory). The platform runs a single daily cron
   * (wrangler.jsonc) that refreshes every source, so adding a source never
   * silently skips its refresh regardless of this value.
   */
  cron: string;
  /** How long cached records stay valid in KV. */
  cacheTtlSeconds: number;
  /**
   * Refresh wave (see store.ts). Cron Triggers are killed after 15 minutes, so
   * the daily refresh is split across staggered triggers: wave 1 = KV snapshot
   * sources (05:00), wave 2 = smaller D1 sources (05:15), wave 3 = charities +
   * care locations (05:30), wave 4 = uk-food-hygiene (05:45), wave 5 =
   * uk-schools (05:50), wave 6 = nhs-ods (05:55), wave 7 = uk-trademark-journal (06:05).
   * Defaults: kv → 1, d1 → 2. Budget each wave at well under 15 minutes on a slow D1 day.
   */
  wave?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /**
   * Refreshed by a GitHub Actions runner (`scripts/runner-refresh.mjs`, in the
   * `gankdat metrics` job) instead of the Worker's cron: the origin serves the
   * Worker an empty body while a runner reads the same URL in full (The Gazette,
   * every day from 2026-09-28). The cron waves skip the source, a stale KV
   * snapshot is served as is (the runner owns freshness), and only a cold cache
   * still refreshes inline. KV sources only.
   */
  runner?: boolean;
}

/**
 * Declarative spec for the public /stats/<slug> cite-bait page (task 34).
 * Lives on the source (isolation rule); a generic engine renders it. Sources
 * without one still get a minimal page (record count + freshness).
 */
export interface StatsGroupSpec {
  field: string;
  title: string;
  limit?: number;
  /** Row order: by count (default, top-N) or by value (chronological for issue/week fields). */
  sort?: 'count' | 'value';
}

/**
 * Bounded sub-pages `/stats/<slug>/<segment>/<value>`, one per listed value
 * (never derived from the data — programmatic SEO stays bounded, see
 * ARCHITECTURE "out of scope"). A value selects records with the query
 * engine's rule for a string param on `field` (case-insensitive substring), so
 * a comma-separated list field such as Nice classes works with one value.
 * Each sub-page carries its own trend and breakdown tables, precomputed at
 * refresh like the parent page.
 */
export interface StatsFacet {
  /** URL segment, e.g. 'class'. */
  segment: string;
  /** Record field the value is matched against. */
  field: string;
  /** Section title on the parent page, e.g. 'By Nice class'. */
  title: string;
  values: readonly { value: string; label: string }[];
  date?: { field: string; title: string };
  groupBy: StatsGroupSpec[];
}

export interface StatsSpec {
  /** ISO-date record field bucketed into the monthly-trend table. */
  date: { field: string; title: string };
  /** Categorical record fields rendered as top-N breakdown tables. */
  groupBy: StatsGroupSpec[];
  facets?: StatsFacet[];
}

/**
 * An on-demand dataset (2026-10-07, uk-company-profiles): the register is far
 * too large to mirror, so a record is read from the origin when a request
 * names it — by one of the `keys` query params — and cached in KV per key.
 * Lookup sources are never refreshed by the cron waves and have no change
 * feed; `fetchFresh` returns the bundled sample records so the schema checks
 * (Blind Mode, Apify) see what the source produces. The generic engine lives
 * in `lookup.ts`; everything origin-specific stays in the source file.
 */
export interface LookupSpec<TRecord = unknown> {
  /** Query params that identify one record; a request must present at least one. */
  keys: readonly string[];
  /** Example args for docs, llms.txt and the directory conformance test, e.g. { company_number: '00000006' }. */
  example: Readonly<Record<string, string>>;
  /** How long a looked-up record (or a confirmed miss) stays cached in KV. */
  cacheTtlSeconds: number;
  /** Read one record from the origin by the presented key(s); null when the origin has no such record. */
  fetchOne(env: CloudflareBindings, params: Record<string, unknown>): Promise<TRecord | null>;
}

/**
 * One dataset behind the platform. Everything dataset-specific lives in the
 * implementing file + a registry entry (CLAUDE.md isolation rule).
 *
 * Filter convention (enforced by the generic query engine, never per-dataset):
 * - a param key naming a record field matches string fields as
 *   case-insensitive substrings, number/boolean fields as strict equality;
 * - `<field>_after` / `<field>_before` params form inclusive ranges over
 *   ISO-date string fields; `<field>_min` / `<field>_max` over numeric fields;
 * - params against array fields match when any element matches;
 * - `page`, `per_page`, and `q` (substring search across all string fields)
 *   are platform-reserved and added to every source automatically.
 * All declared params must be optional.
 */
export interface DataSource<TRecord = unknown> {
  slug: string;
  title: string;
  /** One-liner used by the sources listing, OpenAPI spec, and MCP tool descriptions. */
  description: string;
  /**
   * A dated, plain sentence shown on /stats, in /v1/data and list_sources while the origin is
   * paused or emptied (2026-10-11: planning.data.gov.uk emptied its planning-application
   * dataset; the last snapshot is served and the refresh keeps failing loudly). Unset = nothing.
   */
  notice?: string;
  /**
   * Where records live. 'kv' (default): one cached snapshot value, filtered in
   * JS per request — right for datasets up to a few MB. 'd1': rows in the
   * source_records table, filtered in SQL — for datasets too large for a KV
   * value (25MiB cap). D1 sources must declare SCALAR queryParams only (no
   * array-field filters), normalize date fields to date-only ISO (YYYY-MM-DD)
   * with z.iso.date() params, and refresh via cron/cold-start only (no inline
   * staleness refresh — a full reload is too slow for a request path).
   */
  storage?: 'kv' | 'd1';
  /** zod schema of one normalized record (validated at ingest). */
  recordSchema: z.ZodType<TRecord>;
  /** Filters this source supports; validated per-request by the data route. */
  queryParams: z.ZodObject;
  refresh: RefreshPolicy;
  /** Credits debited per request against this source (default 1). */
  creditCost?: number;
  /** x402 pay-per-request price for this source, e.g. '$0.01' (default: X402_PRICE_USD env / platform default). */
  x402PriceUsd?: string;
  /** Per-source REST rate limit for the metered data route (default 60 req / 60s). */
  rateLimit?: { limit: number; windowSeconds: number };
  /** Breakdown spec for the public /stats/<slug> page (optional enrichment). */
  stats?: StatsSpec;
  /**
   * Stable identity of a record across refreshes (D1 sources). When set, each
   * refresh diffs the new generation against the previous one and records
   * added / removed / changed rows in `source_changes`, served at
   * `/v1/changes/<slug>` (task 51). Sources without a stable id have no feed.
   */
  idOf?(record: TRecord): string;
  /** On-demand lookup by key (see LookupSpec); such a source has no snapshot, refresh or feed. */
  lookup?: LookupSpec<TRecord>;
  /** Pull fresh records from the origin (called by cron refresh / cache miss). */
  fetchFresh(env: CloudflareBindings): Promise<TRecord[]>;
  /**
   * Streaming alternative to fetchFresh, preferred by the D1 refresh when
   * present: yields records one at a time so datasets too large to
   * materialize in Worker memory (tens of MB) can load in O(chunk) space.
   * KV-snapshot sources ignore it.
   */
  fetchStream?(env: CloudflareBindings): AsyncIterable<TRecord>;
}
