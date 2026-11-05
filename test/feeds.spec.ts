import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshD1Source } from '../src/sources/d1store';
import type { ChangeRow } from '../src/sources/d1store';
import { ukCareLocationsSource } from '../src/sources/uk-care-locations';
import { entryTitle, feedUrl, listFeeds, renderAtom, renderOpml } from '../src/routes/feeds';
import { hasChangeFeed, listSources } from '../src/sources/registry';
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

  // gankdat change-feed-shelf-listing (2026-11-05): the day-30 read found no reader had ever added a
  // feed (Feedly's search empty), so the feeds get a discovery page and one OPML of them all.
  it('lists every feed — each register and each listed facet value — once', () => {
    const pages = listFeeds();
    const registers = listSources().filter(hasChangeFeed);
    expect(pages.filter((p) => !p.facet).map((p) => p.source.slug)).toEqual(
      registers.map((s) => s.slug),
    );
    const facetCount = registers.reduce(
      (n, s) => n + (s.stats?.facets ?? []).reduce((m, f) => m + f.values.length, 0),
      0,
    );
    expect(pages.filter((p) => p.facet)).toHaveLength(facetCount);
    expect(facetCount).toBeGreaterThanOrEqual(45);
    expect(new Set(pages.map((p) => feedUrl('https://gankdat.com', p))).size).toBe(pages.length);
  });

  it('serves an OPML 2.0 of every feed, facet feeds nested under their register', async () => {
    const res = await SELF.fetch('https://example.com/feeds/opml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/x-opml');
    const xml = await res.text();
    expect(xml).toContain('<opml version="2.0">');
    for (const page of listFeeds()) {
      expect(xml).toContain(`xmlUrl="${feedUrl('https://gankdat.com', page)}"`);
    }
    expect(xml).toContain(
      'xmlUrl="https://gankdat.com/feeds/uk-trademark-journal.xml" htmlUrl="https://gankdat.com/stats/uk-trademark-journal">',
    );
    expect(xml).toMatch(
      /uk-trademark-journal\.xml" htmlUrl="[^"]+">\n\s+<outline type="rss" [^>]*xmlUrl="https:\/\/gankdat\.com\/feeds\/uk-trademark-journal\/class\/01\.xml"/,
    );
    // Pure render: titles are escaped.
    const opml = renderOpml(
      'https://gankdat.com',
      [{ source: { ...ukCareLocationsSource, title: 'A & <B>' } }],
      'Thu, 05 Nov 2026 19:30:00 GMT',
    );
    expect(opml).toContain('text="A &amp; &lt;B&gt; — changes"');
    expect(opml).toContain('<dateCreated>Thu, 05 Nov 2026 19:30:00 GMT</dateCreated>');
  });

  it('serves a discovery page that links every register feed, the OPML and the shelves', async () => {
    const res = await SELF.fetch('https://example.com/feeds');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="canonical" href="https://gankdat.com/feeds">');
    expect(html).toContain('href="/feeds/opml"');
    for (const source of listSources().filter(hasChangeFeed)) {
      expect(html).toContain(`href="https://gankdat.com/feeds/${source.slug}.xml"`);
      expect(html).toMatch(
        new RegExp(
          `<link rel="alternate" type="application/atom\\+xml" title="[^"]+ — changes" href="https://gankdat.com/feeds/${source.slug}\\.xml">`,
        ),
      );
    }
    expect(html).toContain('href="https://gankdat.com/feeds/uk-trademark-journal/class/09.xml"');
    expect(html).toContain('/feed subscribe');
    expect(html).toContain('n8n (RSS Feed Trigger)');
    // The stats index and llms.txt point at it.
    expect(await (await SELF.fetch('https://example.com/stats')).text()).toContain(
      'href="/feeds/opml"',
    );
    expect(await (await SELF.fetch('https://example.com/llms.txt')).text()).toContain(
      'https://gankdat.com/feeds/opml',
    );
  });
});
