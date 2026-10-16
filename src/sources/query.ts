import { z } from 'zod';
import type { DataSource } from './types';

export const paginationShape = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
};

/** Params handled by the platform, never by a source: pagination + full-text q. */
const RESERVED_KEYS = new Set([...Object.keys(paginationShape), 'q']);

/** The source's declared filters plus the shared pagination and q params. */
export function buildQuerySchema(source: DataSource): z.ZodObject {
  return source.queryParams.extend({
    ...paginationShape,
    q: z.string().optional(),
  });
}

/**
 * Drop params whose value is empty. Hono yields '' for a bare `?x=`, which would
 * otherwise coerce to 0 (turning `?authority=` into an authority===0 filter that
 * matches nothing) or become a match-everything '' substring, or fail per_page's
 * min(1). Treating '' as absent restores the intended "no filter" behaviour.
 */
export function omitEmptyParams(raw: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
}

export interface QueryPage<T> {
  records: T[];
  page: number;
  perPage: number;
  total: number;
}

function matchesValue(actual: unknown, wanted: unknown): boolean {
  if (typeof wanted === 'string' && typeof actual === 'string') {
    return actual.toLowerCase().includes(wanted.toLowerCase());
  }
  return actual === wanted;
}

/** A field counts as present when it is not null/undefined, not an empty string and not an empty array. */
export function isPresent(actual: unknown): boolean {
  if (actual === null || actual === undefined) return false;
  if (typeof actual === 'string') return actual.trim() !== '';
  if (Array.isArray(actual)) return actual.length > 0;
  return true;
}

function matchesFilter(record: Record<string, unknown>, key: string, wanted: unknown): boolean {
  // <field>_present=true|false: whether the field holds a value at all (null, '' and []
  // count as absent). The generic way to ask for "rows missing X", e.g. website_present=false.
  if (key.endsWith(PRESENT_SUFFIX) && typeof wanted === 'boolean') {
    return isPresent(record[key.slice(0, -PRESENT_SUFFIX.length)]) === wanted;
  }
  // <field>_after / <field>_before: inclusive range on ISO date/datetime string
  // fields. Compared as parsed timestamps (not lexicographically) so a date-only
  // bound covers the whole boundary day of a datetime field regardless of its
  // timezone offset (e.g. published_at "2026-07-06T16:09:27+01:00").
  for (const [suffix, cmp] of DATE_RANGE_SUFFIXES) {
    if (key.endsWith(suffix) && typeof wanted === 'string') {
      const actual = record[key.slice(0, -suffix.length)];
      return typeof actual === 'string' && cmp(actual, wanted);
    }
  }
  // <field>_min / <field>_max: inclusive range on numeric fields.
  for (const [suffix, cmp] of NUMBER_RANGE_SUFFIXES) {
    if (key.endsWith(suffix) && typeof wanted === 'number') {
      const actual = record[key.slice(0, -suffix.length)];
      return typeof actual === 'number' && cmp(actual, wanted);
    }
  }
  const actual = record[key];
  // Array fields match when any element matches (substring for strings).
  if (Array.isArray(actual)) {
    return actual.some((element) => matchesValue(element, wanted));
  }
  return matchesValue(actual, wanted);
}

// A date-only bound ('YYYY-MM-DD') spans a whole UTC day: _after includes from
// its start, _before through its end. A datetime bound is used as-is. NaN (an
// unparseable field) fails both, excluding the record rather than throwing.
function boundStart(wanted: string): number {
  return Date.parse(wanted.includes('T') ? wanted : `${wanted}T00:00:00Z`);
}
function boundEnd(wanted: string): number {
  return Date.parse(wanted.includes('T') ? wanted : `${wanted}T23:59:59.999Z`);
}

export const PRESENT_SUFFIX = '_present';

const DATE_RANGE_SUFFIXES: [string, (actual: string, wanted: string) => boolean][] = [
  ['_after', (actual, wanted) => Date.parse(actual) >= boundStart(wanted)],
  ['_before', (actual, wanted) => Date.parse(actual) <= boundEnd(wanted)],
];

const NUMBER_RANGE_SUFFIXES: [string, (actual: number, wanted: number) => boolean][] = [
  ['_min', (actual, wanted) => actual >= wanted],
  ['_max', (actual, wanted) => actual <= wanted],
];

function matchesFullText(record: Record<string, unknown>, q: string): boolean {
  const needle = q.toLowerCase();
  return Object.values(record).some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
  );
}

/**
 * Generic, schema-driven filtering — never per-dataset. String params match as
 * case-insensitive substrings, number/boolean params as strict equality,
 * `<field>_after`/`<field>_before` as inclusive ranges, `<field>_present` as a
 * has-a-value test, and `q` as a substring search across all string fields.
 */
export function applyQuery<T>(records: T[], parsedQuery: Record<string, unknown>): QueryPage<T> {
  const filters = Object.entries(parsedQuery).filter(
    ([key, value]) => !RESERVED_KEYS.has(key) && value !== undefined,
  );
  const q = parsedQuery.q;

  const filtered = records.filter((record) => {
    const fields = record as Record<string, unknown>;
    if (typeof q === 'string' && !matchesFullText(fields, q)) return false;
    return filters.every(([key, wanted]) => matchesFilter(fields, key, wanted));
  });

  const page = parsedQuery.page as number;
  const perPage = parsedQuery.per_page as number;
  return {
    records: filtered.slice((page - 1) * perPage, page * perPage),
    page,
    perPage,
    total: filtered.length,
  };
}
