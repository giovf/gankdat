import { describe, expect, it } from 'vitest';
import { demoSource } from './helpers/demo-source';
import { applyQuery, buildQuerySchema } from '../src/sources/query';
import { getSource, listSources } from '../src/sources/registry';

const RECORDS = [
  { id: 'r1', name: 'Alpha Works', category: 'industrial', score: 82, active: true },
  { id: 'r2', name: 'Beta House', category: 'residential', score: 67, active: true },
  { id: 'r3', name: 'Gamma Yard', category: 'industrial', score: 45, active: false },
];

function parseQuery(query: Record<string, string>): Record<string, unknown> {
  const result = buildQuerySchema(demoSource).safeParse(query);
  if (!result.success) throw new Error(`unexpected parse failure: ${result.error.message}`);
  return result.data;
}

describe('registry', () => {
  it('looks up sources by slug and lists them', () => {
    expect(getSource('uk-planning')?.slug).toBe('uk-planning');
    expect(getSource('nope')).toBeUndefined();
    expect(listSources().map((s) => s.slug)).toEqual([
      'uk-planning',
      'uk-tenders',
      'uk-contract-awards',
      'uk-sanctions',
      'eu-ted',
      'sam-exclusions',
      'uk-insolvency',
      'uk-companies',
      'uk-food-hygiene',
      'uk-sponsors',
      'uk-charities',
      'uk-care-locations',
      'uk-schools',
      'nhs-ods',
      'uk-trademark-journal',
      'uk-gambling-operators',
      'uk-company-profiles',
    ]);
  });
});

describe('buildQuerySchema', () => {
  it('applies pagination defaults and source filters', () => {
    const parsed = parseQuery({ category: 'industrial' });
    expect(parsed).toMatchObject({ page: 1, per_page: 25, category: 'industrial' });
  });

  it('rejects out-of-bounds pagination', () => {
    const schema = buildQuerySchema(demoSource);
    expect(schema.safeParse({ per_page: '1000' }).success).toBe(false);
    expect(schema.safeParse({ page: '0' }).success).toBe(false);
    expect(schema.safeParse({ page: '2.5' }).success).toBe(false);
  });

  it('coerces typed filters from query strings', () => {
    const parsed = parseQuery({ score: '82', active: 'true' });
    expect(parsed.score).toBe(82);
    expect(parsed.active).toBe(true);
  });
});

describe('applyQuery', () => {
  it('matches string filters as case-insensitive substrings', () => {
    const result = applyQuery(RECORDS, parseQuery({ name: 'alpha' }));
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  it('matches non-string filters by strict equality', () => {
    expect(applyQuery(RECORDS, parseQuery({ score: '67' })).records.map((r) => r.id)).toEqual([
      'r2',
    ]);
    expect(applyQuery(RECORDS, parseQuery({ active: 'false' })).records.map((r) => r.id)).toEqual([
      'r3',
    ]);
  });

  it('combines filters with AND semantics', () => {
    const result = applyQuery(RECORDS, parseQuery({ category: 'industrial', active: 'true' }));
    expect(result.records.map((r) => r.id)).toEqual(['r1']);
  });

  it('paginates after filtering and reports the filtered total', () => {
    const result = applyQuery(RECORDS, { page: 2, per_page: 1, category: 'industrial' });
    expect(result).toMatchObject({ page: 2, perPage: 1, total: 2 });
    expect(result.records.map((r) => (r as { id: string }).id)).toEqual(['r3']);
  });

  it('returns an empty page beyond the last record without erroring', () => {
    const result = applyQuery(RECORDS, { page: 99, per_page: 25 });
    expect(result.records).toEqual([]);
    expect(result.total).toBe(3);
  });

  it('searches all string fields with the reserved q param', () => {
    const result = applyQuery(RECORDS, parseQuery({ q: 'yard' }));
    expect(result.records.map((r) => r.id)).toEqual(['r3']);
    expect(applyQuery(RECORDS, parseQuery({ q: 'residential' })).records.map((r) => r.id)).toEqual([
      'r2',
    ]);
  });

  it('applies inclusive _after/_before ranges over ISO-date string fields', () => {
    const dated = [
      { id: 'd1', decided: '2023-05-09' },
      { id: 'd2', decided: '2024-06-30' },
      { id: 'd3', decided: null },
    ];
    const after = applyQuery(dated, { page: 1, per_page: 25, decided_after: '2024-01-01' });
    expect(after.records.map((r) => r.id)).toEqual(['d2']);
    const before = applyQuery(dated, { page: 1, per_page: 25, decided_before: '2023-05-09' });
    expect(before.records.map((r) => r.id)).toEqual(['d1']);
  });

  it('applies inclusive _min/_max ranges over numeric fields', () => {
    const priced = [
      { id: 'p1', value: 100 },
      { id: 'p2', value: 5000 },
      { id: 'p3', value: null },
    ];
    expect(
      applyQuery(priced, { page: 1, per_page: 25, value_min: 100 }).records.map((r) => r.id),
    ).toEqual(['p1', 'p2']);
    expect(
      applyQuery(priced, { page: 1, per_page: 25, value_max: 4999 }).records.map((r) => r.id),
    ).toEqual(['p1']);
  });

  it('applies <field>_present as a has-a-value test (null, empty string and [] are absent)', () => {
    const rows = [
      { id: 'a', website: 'https://a.example', tags: ['x'] },
      { id: 'b', website: null, tags: [] },
      { id: 'c', website: '   ', tags: ['y'] },
      { id: 'd', tags: null },
    ];
    const ids = (parsed: Record<string, unknown>): string[] =>
      applyQuery(rows, { page: 1, per_page: 25, ...parsed }).records.map((r) => r.id);
    expect(ids({ website_present: true })).toEqual(['a']);
    expect(ids({ website_present: false })).toEqual(['b', 'c', 'd']);
    expect(ids({ tags_present: true })).toEqual(['a', 'c']);
    expect(ids({ tags_present: false })).toEqual(['b', 'd']);
  });

  it('matches array fields when any element matches', () => {
    const tagged = [
      { id: 't1', codes: ['79993000', '50700000'] },
      { id: 't2', codes: ['45233139'] },
      { id: 't3', codes: [] },
    ];
    expect(
      applyQuery(tagged, { page: 1, per_page: 25, codes: '50700000' }).records.map((r) => r.id),
    ).toEqual(['t1']);
  });
});
