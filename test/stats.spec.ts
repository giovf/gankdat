import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeStats } from '../src/lib/stats';
import { snapshotWrites } from '../src/sources/cache';
import { listSources } from '../src/sources/registry';
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
