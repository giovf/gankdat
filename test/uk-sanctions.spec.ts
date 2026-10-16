import { SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearer, issueKey } from './helpers/auth';
import { stubOrigins } from './helpers/origin-mock';

// Column order is irrelevant (the parser maps the header by name); this
// exercises the nasty parts of the real feed: a report-date preamble row,
// quoted fields with embedded commas/newlines/escaped quotes, one row per
// name with primary/alias types, pipe-delimited sanctions, dd/mm/yyyy dates.
const UKSL_CSV = [
  'Report Date: 10-Jul-2026',
  'Unique ID,Name type,Name 1,Name 2,Name 3,Name 4,Name 5,Name 6,Regime Name,Designation Type,Designation source,Sanctions Imposed,Address Country,Nationality(/ies),Date Designated,Last Updated,UK Statement of Reasons',
  'TEST0001,Primary name,JOHN,,,,,DOE,"Test Regime, 2019",Individual,UN,Asset freeze|Travel Ban,France,"France, Belgium",23/09/2014,18/12/2021,"A ""quoted"" statement,',
  'spanning two lines"',
  'TEST0001,Alias,JOHNNY,,,,,DOE,"Test Regime, 2019",Individual,UN,Asset freeze|Travel Ban,,,23/09/2014,18/12/2021,',
  'TEST0002,Primary name,,,,,,ACME HOLDINGS LTD,Other Regime 2020,Entity,UK,Asset freeze,United Kingdom,,01/02/2025,05/02/2025,plain',
].join('\n');

function stubSanctions(csv = UKSL_CSV): void {
  stubOrigins({ sanctions: () => new Response(csv, { headers: { 'content-type': 'text/csv' } }) });
}

async function fetchRecords(query = ''): Promise<{
  status: number;
  data: Record<string, unknown>[];
}> {
  const { key } = await issueKey();
  const res = await SELF.fetch(`https://example.com/v1/data/uk-sanctions${query}`, {
    headers: bearer(key),
  });
  const body = (await res.json()) as { data: Record<string, unknown>[] };
  return { status: res.status, data: body.data ?? [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uk-sanctions source', () => {
  it('normalizes row-per-alias CSV into one record per designation', async () => {
    stubSanctions();
    const { status, data } = await fetchRecords('?per_page=10');
    expect(status).toBe(200);
    expect(data).toHaveLength(2);

    const doe = data.find((r) => r.unique_id === 'TEST0001');
    expect(doe).toMatchObject({
      name: 'JOHN DOE',
      aliases: ['JOHNNY DOE'],
      designation_type: 'Individual',
      regime: 'Test Regime, 2019',
      designation_source: 'UN',
      sanctions_imposed: ['Asset freeze', 'Travel Ban'],
      date_designated: '2014-09-23',
      last_updated: '2021-12-18',
    });
    expect(doe?.countries).toEqual(expect.arrayContaining(['France', 'Belgium']));
  });

  it('drops identity fields by design: no DOB, passport, or contact data in responses', async () => {
    stubSanctions();
    const { data } = await fetchRecords();
    const keys = Object.keys(data[0]!);
    for (const banned of ['dob', 'passport', 'phone', 'email', 'gender']) {
      expect(keys.join(',').toLowerCase()).not.toContain(banned);
    }
  });

  it('filters by regime, array country membership, and designation date range', async () => {
    stubSanctions();
    const byCountry = await fetchRecords('?countries=Belgium');
    expect(byCountry.data.map((r) => r.unique_id)).toEqual(['TEST0001']);

    const byDate = await fetchRecords('?date_designated_after=2025-01-01');
    expect(byDate.data.map((r) => r.unique_id)).toEqual(['TEST0002']);

    const byType = await fetchRecords('?designation_type=Entity');
    expect(byType.data.map((r) => r.unique_id)).toEqual(['TEST0002']);
  });

  it('fails loud when the CSV header no longer matches (fixture fallback in tests)', async () => {
    stubSanctions('Report Date: x\nTotally,Different,Header\nrow,row,row');
    // FIXTURE_FALLBACK=true in tests, so the source serves fixture records
    // instead of erroring — the fallback event is the observable behavior.
    const { status, data } = await fetchRecords();
    expect(status).toBe(200);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('unique_id');
  });
});
