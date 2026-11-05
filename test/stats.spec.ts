import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeStats } from '../src/lib/stats';
import { putSourceStats, snapshotWrites } from '../src/sources/cache';
import { getSource, listSources } from '../src/sources/registry';
import { isRunnerFed, refreshAllSources } from '../src/sources/store';
import { planningResponse, stubOrigins, tendersResponse } from './helpers/origin-mock';

function stubBoth(): void {
  stubOrigins({
    planning: () =>
      planningResponse([
        {
          entity: 1,
          reference: 'A/1',
          'organisation-entity': 109,
          description: 'Rear extension',
          'entry-date': '2026-06-01',
          'decision-date': '2026-06-20',
          'start-date': '',
          'end-date': '',
          point: '',
        },
        {
          entity: 2,
          reference: 'B/2',
          'organisation-entity': 109,
          description: 'Loft conversion',
          'entry-date': '2026-07-02',
          'decision-date': '',
          'start-date': '',
          'end-date': '',
          point: '',
        },
      ]),
    tenders: () =>
      tendersResponse([
        {
          id: 'n/1',
          ocid: 'ocds-a',
          date: '2026-06-15T00:00:00Z',
          buyer: { name: 'NHS England' },
          tender: { title: 'Software', status: 'active' },
        },
        {
          id: 'n/2',
          ocid: 'ocds-b',
          date: '2026-07-01T00:00:00Z',
          buyer: { name: 'NHS England' },
          tender: { title: 'Cleaning', status: 'complete' },
        },
      ]),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('computeStats', () => {
  it('buckets by month, counts groups top-N, skips null/empty values', () => {
    const records = [
      { d: '2026-06-01', k: 'a' },
      { d: '2026-06-20', k: 'a' },
      { d: '2026-07-01', k: 'b' },
      { d: null, k: '' },
    ];
    const stats = computeStats(records, {
      date: { field: 'd', title: 'by month' },
      groupBy: [{ field: 'k', title: 'by k', limit: 1 }],
    });
    expect(stats.total).toBe(4);
    expect(stats.monthly?.buckets).toEqual([
      { month: '2026-06', count: 2 },
      { month: '2026-07', count: 1 },
    ]);
    expect(stats.groups[0]?.rows).toEqual([{ value: 'a', count: 2 }]);
  });

  it('computes one sub-page per listed facet value with the string-param match rule', () => {
    const rows = [
      { classes: '09,35', issue: '2026/037', d: '2026-09-11', who: 'A Ltd' },
      { classes: '09', issue: '2026/038', d: '2026-09-18', who: 'B Ltd' },
      { classes: '25', issue: '2026/038', d: '2026-09-18', who: null },
    ];
    const stats = computeStats(rows, {
      date: { field: 'd', title: 'by month' },
      groupBy: [],
      facets: [
        {
          segment: 'class',
          field: 'classes',
          title: 'By class',
          values: [
            { value: '09', label: 'Software' },
            { value: '13', label: 'Firearms' },
          ],
          date: { field: 'd', title: 'by month' },
          groupBy: [
            { field: 'issue', title: 'per issue', sort: 'value', limit: 52 },
            { field: 'who', title: 'who' },
          ],
        },
      ],
    });
    expect(stats.facets).toHaveLength(1);
    const [nine, thirteen] = stats.facets?.[0]?.pages ?? [];
    expect(nine).toEqual({
      value: '09',
      label: 'Software',
      total: 2,
      monthly: { title: 'by month', buckets: [{ month: '2026-09', count: 2 }] },
      groups: [
        {
          title: 'per issue',
          rows: [
            { value: '2026/037', count: 1 },
            { value: '2026/038', count: 1 },
          ],
        },
        {
          title: 'who',
          rows: [
            { value: 'A Ltd', count: 1 },
            { value: 'B Ltd', count: 1 },
          ],
        },
      ],
    });
    expect(thirteen).toEqual({
      value: '13',
      label: 'Firearms',
      total: 0,
      monthly: null,
      groups: [],
    });
  });

  it('without a spec still reports the total (minimal page for spec-less sources)', () => {
    const stats = computeStats([{ x: 1 }]);
    expect(stats).toEqual({ total: 1, monthly: null, groups: [] });
  });
});

describe('GET /stats', () => {
  it('indexes every registered source', async () => {
    const res = await SELF.fetch('https://example.com/stats');
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const source of listSources()) {
      expect(html).toContain(`/stats/${source.slug}`);
    }
  });

  it('renders a paused source whose blob has expired as a page carrying the notice, not a 503', async () => {
    const planning = listSources().find((s) => s.slug === 'uk-planning')!;
    expect(planning.notice).toBeTruthy();
    const res = await SELF.fetch('https://example.com/stats/uk-planning');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('origin notice:');
    expect(html).toContain(planning.notice!.slice(0, 40));
    expect(html).toMatch(/<link rel="canonical" href="[^"]+\/stats\/uk-planning">/);
    // 2026-10-19 (uk-planning-apify-pause): the state is one word in the headline, and the page
    // names every paused surface, the Apify actor included, so a buyer reads it before a run.
    expect(html).toContain('<tr><td>state</td><td><b>paused</b>');
    expect(html).toContain('the Apify actor answer');
  });

  it('marks a paused source on the index and leaves live sources unmarked', async () => {
    const res = await SELF.fetch('https://example.com/stats');
    const html = await res.text();
    expect(html).toMatch(/\/stats\/uk-planning">[^<]*<\/a>[^—]*· paused<\/span>/);
    expect(html).toMatch(/\/stats\/uk-tenders">[^<]*<\/a>(?:(?!paused)[^—])*—/);
  });

  it('dates a facet page carried past the refresh budget by the refresh it was computed for', async () => {
    // d1store carries a facet page from the previous blob when the 4-minute facet budget runs out
    // (gankdat sitemap-5xx-read, 2026-10-26); the page then shows its own date, not the parent's.
    const source = getSource('uk-trademark-journal')!;
    await putSourceStats(
      env,
      source,
      {
        total: 10,
        monthly: null,
        groups: [],
        facets: [
          {
            segment: 'class',
            field: 'classes',
            title: 'By Nice class',
            pages: [
              { value: '09', label: 'Nine', total: 4, monthly: null, groups: [] },
              {
                value: '42',
                label: 'Forty-two',
                total: 3,
                monthly: null,
                groups: [],
                as_of: '2026-10-24T06:05:00.000Z',
              },
            ],
          },
        ],
      },
      '2026-10-26T06:05:00.000Z',
    );
    const fresh = await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/09');
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain('<td>last refreshed</td><td>2026-10-26</td>');
    const carried = await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/42');
    expect(carried.status).toBe(200);
    const html = await carried.text();
    expect(html).toContain('<td>last refreshed</td><td>2026-10-24</td>');
    expect(html).toContain('"dateModified":"2026-10-24T06:05:00.000Z"');
    // A value past the budget with no earlier page is still being prepared.
    const missing = await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/01');
    expect(missing.status).toBe(503);
  });

  it('names the class first, writes a 150-word dated summary and links the neighbouring pages', async () => {
    // gankdat stats-page-content-depth (2026-11-05): the day-30 IndexNow read put 3 of 62 /stats URLs
    // in Bing's index after 330 Bingbot fetches — crawled, declined as thin. Every facet page now
    // carries prose computed from its own numbers, a class-first title and cross-links.
    const source = getSource('uk-trademark-journal')!;
    const page = (value: string, label: string, total: number) => ({
      value,
      label,
      total,
      monthly: null,
      groups: [],
    });
    await putSourceStats(
      env,
      source,
      {
        total: 1_000,
        monthly: {
          title: 'Applications published by month',
          buckets: [
            { month: '2026-10', count: 600 },
            { month: '2026-11', count: 400 },
          ],
        },
        groups: [
          {
            title: 'By applicant country',
            rows: [
              { value: 'GB', count: 700 },
              { value: 'US', count: 300 },
            ],
          },
        ],
        facets: [
          {
            segment: 'class',
            field: 'classes',
            title: 'By Nice class',
            pages: [
              page('01', 'Chemicals', 20),
              {
                ...page('09', 'Scientific and electrical apparatus', 250),
                monthly: {
                  title: 'Applications published by month',
                  buckets: [
                    { month: '2026-10', count: 150 },
                    { month: '2026-11', count: 100 },
                  ],
                },
                groups: [
                  {
                    title: 'By applicant country',
                    rows: [
                      { value: 'GB', count: 200 },
                      { value: 'US', count: 50 },
                    ],
                  },
                  {
                    title: 'Organisations with most applications',
                    rows: [{ value: 'Acme <Ltd>', count: 9 }],
                  },
                ],
              },
              page('10', 'Medical apparatus', 30),
              page('35', 'Advertising and business services', 700),
            ],
          },
        ],
      },
      '2026-11-05T06:05:00.000Z',
    );
    const res = await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/09');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<title>Class 09 trade mark applications: Scientific and electrical apparatus — ',
    );
    expect(html).toContain(
      '<h1>Class 09 trade mark applications: <b>Scientific and electrical apparatus</b></h1>',
    );
    const summary = /<section class="summary">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
    const words = summary
      .replace(/<[^>]+>/g, ' ')
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w));
    expect(words.length).toBeGreaterThanOrEqual(150);
    expect(summary).toContain('As of 5 November 2026');
    expect(summary).toContain('In November 2026 so far, 100 trade mark applications in class 09');
    expect(summary).toContain('25.0% of the 1,000 trade mark applications');
    // Origin-controlled names are escaped in the prose too.
    expect(summary).toContain('Acme &lt;Ltd&gt; leads with 9');
    expect(html).not.toContain('Acme <Ltd>');
    // Cross-links: the neighbours by value and the largest class, never the page itself twice.
    expect(html).toContain('href="/stats/uk-trademark-journal/class/01">Class 01: Chemicals</a>');
    expect(html).toContain(
      'href="/stats/uk-trademark-journal/class/10">Class 10: Medical apparatus</a>',
    );
    expect(html).toContain(
      'href="/stats/uk-trademark-journal/class/35">Class 35: Advertising and business services</a>',
    );
    expect(html).not.toContain('href="/stats/uk-trademark-journal/class/09"');
    // The parent page carries its own dated summary and names the largest classes.
    const parent = await (
      await SELF.fetch('https://example.com/stats/uk-trademark-journal')
    ).text();
    expect(parent).toContain('<section class="summary"><p>As of 5 November 2026, ');
    expect(parent).toContain(
      'By class, the largest of the 4 pages are class 35 (Advertising and business services) with 700',
    );
    // A sibling's summary is its own: no paragraph shared with class 09.
    const other = await (
      await SELF.fetch('https://example.com/stats/uk-trademark-journal/class/10')
    ).text();
    const otherSummary = /<section class="summary">([\s\S]*?)<\/section>/.exec(other)?.[1] ?? '';
    for (const p of summary.split('</p>')) {
      if (p.trim()) expect(otherSummary).not.toContain(p);
    }
  });

  it('returns 503 (never refreshes) for a source whose stats are not yet computed', async () => {
    // Public page must not drive a refresh; before any cron/refresh it warms.
    const res = await SELF.fetch('https://example.com/stats/uk-tenders');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('unavailable');
  });

  it('serves a citable page per source from precomputed stats', async () => {
    // Stats are precomputed at refresh (origins stubbed → fixtures for the
    // sources stubBoth doesn't cover); the public page then reads the blob.
    stubBoth();
    await refreshAllSources(env);
    // Runner-fed sources (uk-insolvency) are written by scripts/runner-refresh.mjs, which makes
    // exactly these KV writes from the source's own fetchFresh — the page must read them the same.
    for (const source of listSources().filter(isRunnerFed)) {
      const records = await source.fetchFresh(env);
      for (const w of snapshotWrites(source, records, new Date().toISOString())) {
        await env.CACHE.put(w.key, w.value, { expirationTtl: w.ttl });
      }
    }
    for (const source of listSources()) {
      const res = await SELF.fetch(`https://example.com/stats/${source.slug}`);
      expect(res.status, `${source.slug} stats page`).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain(source.title);
      expect(html).toContain('"@type":"Dataset"');
      expect(html).toContain(`/v1/data/${source.slug}`);
      expect(html).toContain('records in dataset');
    }
  });

  it('escapes origin-controlled values in breakdown tables', async () => {
    stubOrigins({
      tenders: () =>
        tendersResponse([
          {
            id: 'n/1',
            ocid: 'ocds-a',
            date: '2026-07-01T00:00:00Z',
            buyer: { name: '<script>alert(1)</script>' },
            tender: { title: 'x', status: 'active' },
          },
        ]),
    });
    await refreshAllSources(env);
    const html = await (await SELF.fetch('https://example.com/stats/uk-tenders')).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('404s unknown sources with the error envelope', async () => {
    const res = await SELF.fetch('https://example.com/stats/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});
