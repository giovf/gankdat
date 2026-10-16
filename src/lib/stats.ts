import type { StatsFacet, StatsGroupSpec, StatsSpec } from '../sources/types';

// Generic aggregation for the /stats cite-bait pages: registry-driven, so a
// new source gets a page from its (optional) StatsSpec with no platform code.
// Records are the same cached rows the API serves — stats can't contradict
// the product.

export interface StatsGroup {
  title: string;
  rows: { value: string; count: number }[];
}

export interface MonthlyTrend {
  title: string;
  buckets: { month: string; count: number }[];
}

/** One refresh day's diff against the previous generation (register datasets). */
export interface ChangeDay {
  /** YYYY-MM-DD of the refresh that observed the changes. */
  date: string;
  added: number;
  removed: number;
  changed: number;
}

/** One precomputed sub-page of a StatsFacet (e.g. one Nice class). */
export interface FacetPage {
  value: string;
  label: string;
  total: number;
  monthly: MonthlyTrend | null;
  groups: StatsGroup[];
}

export interface FacetStats {
  segment: string;
  field: string;
  title: string;
  pages: FacetPage[];
}

export interface SourceStats {
  total: number;
  /** Chronological YYYY-MM buckets (up to the most recent 12 present). */
  monthly: MonthlyTrend | null;
  groups: StatsGroup[];
  /**
   * Change-feed activity, newest day first, over the last 30 days — set only
   * for register datasets (a stable record id, D1). Present but empty until
   * the second refresh has produced a diff. Precomputed at refresh like the
   * rest, so the public page never touches source_changes per request.
   */
  changes?: ChangeDay[];
  /** Sub-pages per StatsSpec.facets, in spec order; absent for blobs computed before facets existed. */
  facets?: FacetStats[];
}

const asRecord = (row: unknown): Record<string, unknown> =>
  (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;

function monthlyOf(
  records: unknown[],
  date: { field: string; title: string },
): MonthlyTrend | null {
  const byMonth = new Map<string, number>();
  for (const row of records) {
    const raw = asRecord(row)[date.field];
    if (typeof raw !== 'string' || !/^\d{4}-\d{2}/.test(raw)) continue;
    const month = raw.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  }
  const buckets = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([month, count]) => ({ month, count }));
  return buckets.length > 0 ? { title: date.title, buckets } : null;
}

/** Sorts breakdown rows per the group's `sort`: top-N by count (ties by value) or ascending by value. */
export function sortGroupRows<T extends { value: string; count: number }>(
  rows: T[],
  sort: StatsGroupSpec['sort'],
): T[] {
  return sort === 'value'
    ? rows.sort((a, b) => a.value.localeCompare(b.value))
    : rows.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function groupsOf(records: unknown[], specs: StatsGroupSpec[]): StatsGroup[] {
  const groups: StatsGroup[] = [];
  for (const group of specs) {
    const counts = new Map<string, number>();
    for (const row of records) {
      const raw = asRecord(row)[group.field];
      if (raw === null || raw === undefined || raw === '') continue;
      const key = String(raw);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const rows = sortGroupRows(
      [...counts.entries()].map(([value, count]) => ({ value, count })),
      group.sort,
    ).slice(0, group.limit ?? 10);
    if (rows.length > 0) groups.push({ title: group.title, rows });
  }
  return groups;
}

/** The query engine's rule for a string param: case-insensitive substring on a text field. */
function facetMatches(row: unknown, field: string, value: string): boolean {
  const raw = asRecord(row)[field];
  return typeof raw === 'string' && raw.toLowerCase().includes(value.toLowerCase());
}

function facetsOf(records: unknown[], facets: StatsFacet[]): FacetStats[] {
  return facets.map((facet) => ({
    segment: facet.segment,
    field: facet.field,
    title: facet.title,
    pages: facet.values.map(({ value, label }) => {
      const subset = records.filter((row) => facetMatches(row, facet.field, value));
      return {
        value,
        label,
        total: subset.length,
        monthly: facet.date ? monthlyOf(subset, facet.date) : null,
        groups: groupsOf(subset, facet.groupBy),
      };
    }),
  }));
}

export function computeStats(records: unknown[], spec?: StatsSpec): SourceStats {
  const stats: SourceStats = { total: records.length, monthly: null, groups: [] };
  if (!spec) return stats;
  stats.monthly = monthlyOf(records, spec.date);
  stats.groups = groupsOf(records, spec.groupBy);
  if (spec.facets) stats.facets = facetsOf(records, spec.facets);
  return stats;
}
