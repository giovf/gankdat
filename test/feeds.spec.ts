import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshD1Source } from '../src/sources/d1store';
import type { ChangeRow } from '../src/sources/d1store';
import { ukCareLocationsSource } from '../src/sources/uk-care-locations';
import { entryTitle, feedUrl, renderAtom } from '../src/routes/feeds';
import { stubOrigins } from './helpers/origin-mock';

// Keyless Atom feeds of the change feeds: the register's last week of added / removed /
// changed rows, rendered once an hour from D1 into KV, 404 for datasets without a feed and
// for facet values the source does not list, and advertised from the stats pages.

const PAGE = '<a href="https://www.cqc.org.uk/system/files/2026-09/x_CQC_directory.csv">csv</a>';
const HEADER =
  "Name,Also known as,Address,Postcode,Phone number,Service's website (if available),Service types,Date of latest check,Specialisms/services,Provider name,Local authority,Region,Location URL,CQC Location ID (for office use only),CQC Provider ID (for office use only)";
const row = (id: string, name: string, check: string): string =>
  `${name},,"1 Road,Town",AB1 2CD,,,Care home,${check},Dementia,Prov Ltd,Leeds,Yorkshire & Humberside,https://www.cqc.org.uk/location/${id},${id},1-9`;
const DAY1 = [
  HEADER,
  row('1-A', 'Alpha House', '01/Jan/2024 - 00:00'),
  row('1-B', 'Beta Lodge', '01/Jan/2024 - 00:00'),
].join('\n');
const DAY2 = [
  HEADER,
  row('1-A', 'Alpha House', '01/Jan/2024 - 00:00'),
  row('1-D', 'Delta Villa', '10/Sep/2026 - 00:00'),
].join('\n');

async function loadWith(csv: string): Promise<void> {
  stubOrigins({ cqcPage: () => new Response(PAGE), cqcFile: () => new Response(csv) });
  await refreshD1Source(env, ukCareLocationsSource);
  vi.unstubAllGlobals();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderAtom', () => {
  const rows: ChangeRow[] = [
    {
      change: 'added',
      changed_at: '2026-10-05T05:30:00.000Z',
      record_id: 'x-1',
      record: {
        location_id: 'x-1',
        name: 'Delta <Villa>',
        url: 'https://example.com/x',
        region: 'Leeds',
      },
    },
  ];
  it('is a valid-looking Atom document with one entry per row, linking the stats page and the sign-up', () => {
    const xml = renderAtom(
      'https://gankdat.com',
      { source: ukCareLocationsSource },
      rows,
      '2026-10-05T06:00:00.000Z',
    );
    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">',
      ),
    ).toBe(true);
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://gankdat.com/feeds/uk-care-locations.xml"/>',
    );
    expect(xml).toContain(
      '<link rel="alternate" type="text/html" href="https://gankdat.com/stats/uk-care-locations"/>',
    );
    expect(xml).toContain('<updated>2026-10-05T05:30:00.000Z</updated>');
    expect(xml).toContain(
      '<id>tag:gankdat.com,2026:uk-care-locations/2026-10-05T05:30:00.000Z/added/x-1</id>',
    );
    expect(xml).toContain('<title>added: Delta &lt;Villa&gt; — Leeds</title>');
    expect(xml).toContain('https://gankdat.com/#key');
    expect(xml).not.toContain('<Villa>');
  });
  it('titles a record from its short string fields, never ids or URLs, else the record id', () => {
    expect(entryTitle(rows[0] as ChangeRow)).toBe('added: Delta <Villa> — Leeds');
    expect(
      entryTitle({
        change: 'removed',
        changed_at: 't',
        record_id: 'r-9',
        record: { id: 'r-9', url: 'https://a' },
      }),
    ).toBe('removed: r-9');
  });
  it('builds facet feed URLs with the value encoded', () => {
    const spec = {
      segment: 'class',
      field: 'classes',
      title: 'By class',
      values: [{ value: '09', label: 'Electrical' }],
      groupBy: [],
    };
    expect(
      feedUrl('https://gankdat.com', {
        source: ukCareLocationsSource,
        facet: { spec, value: 'a b', label: 'l' },
      }),
    ).toBe('https://gankdat.com/feeds/uk-care-locations/class/a%20b.xml');
  });
});

describe('GET /feeds', () => {
  it('serves the week of changes as Atom, caches it in KV, and 404s what has no feed', async () => {
    await loadWith(DAY1);
    await loadWith(DAY2);
    const res = await SELF.fetch('https://example.com/feeds/uk-care-locations.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/atom+xml');
    const xml = await res.text();
    expect(xml).toContain('<category term="added"/>');
    expect(xml).toContain('<category term="removed"/>');
    expect(xml).toContain('Delta Villa');
    expect(xml).toContain('Beta Lodge');
    expect(await env.CACHE.get('feed:uk-care-locations', 'text')).toBe(xml);
    // A KV source has no change feed; a feed name without .xml is not a feed.
    expect((await SELF.fetch('https://example.com/feeds/uk-tenders.xml')).status).toBe(404);
    expect((await SELF.fetch('https://example.com/feeds/uk-care-locations')).status).toBe(404);
    expect(
      (await SELF.fetch('https://example.com/feeds/uk-care-locations/region/Leeds.xml')).status,
    ).toBe(404);
  });
});
