import { env, SELF } from 'cloudflare:test';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY_SHAPE,
  postIndexNow,
  statsUrlsFor,
} from '../src/lib/indexnow';
import type { SourceStats } from '../src/lib/stats';
import { refreshOne } from '../src/sources/store';
import type { DataSource } from '../src/sources/types';

// IndexNow: the key file at the site root, the URL list a refreshed source produces and the
// POST itself (chunked, never throwing) — made by the GitHub runner, not the Worker, since
// 2026-10-07 (api.indexnow.org answers 429 to Workers egress). The key is a plain wrangler
// var read from wrangler.jsonc by the test pool.

const key = env.INDEXNOW_KEY;

interface Call {
  url: string;
  body: { host: string; key: string; keyLocation: string; urlList: string[] };
}

function recorder(status = 202): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string, init: RequestInit): Promise<Response> => {
    calls.push({ url: input, body: JSON.parse(String(init.body)) as Call['body'] });
    return Promise.resolve(new Response(null, { status }));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const stats: SourceStats = {
  total: 3,
  monthly: null,
  groups: [],
  facets: [
    {
      segment: 'class',
      field: 'nice_class',
      title: 'Nice class',
      pages: [
        { value: '09', label: 'Electrical', total: 2, monthly: null, groups: [] },
        { value: '42', label: 'Software', total: 1, monthly: null, groups: [] },
      ],
    },
  ],
};

describe('IndexNow key file', () => {
  it('is a wrangler var of the protocol shape', () => {
    expect(INDEXNOW_KEY_SHAPE.test(key)).toBe(true);
  });

  it('serves the key at /<key>.txt and nothing else at that shape', async () => {
    const ok = await SELF.fetch(`https://gankdat.com/${key}.txt`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await ok.text()).toBe(key);
    const other = await SELF.fetch('https://gankdat.com/0123456789abcdef0123456789abcdef.txt');
    expect(other.status).toBe(404);
    // Shorter well-known text files are untouched by the route.
    const llms = await SELF.fetch('https://gankdat.com/llms.txt');
    expect(llms.status).toBe(200);
  });
});

describe('statsUrlsFor', () => {
  it('lists the parent page and every facet sub-page', () => {
    expect(statsUrlsFor('https://gankdat.com/', 'uk-trademark-journal', stats)).toEqual([
      'https://gankdat.com/stats/uk-trademark-journal',
      'https://gankdat.com/stats/uk-trademark-journal/class/09',
      'https://gankdat.com/stats/uk-trademark-journal/class/42',
    ]);
    expect(statsUrlsFor('https://gankdat.com', 'uk-tenders', null)).toEqual([
      'https://gankdat.com/stats/uk-tenders',
    ]);
  });
});

describe('postIndexNow', () => {
  it('POSTs host, key, key location and the de-duplicated list', async () => {
    const { calls, fetchImpl } = recorder();
    const result = await postIndexNow({
      baseUrl: 'https://gankdat.com',
      key,
      urls: [
        'https://gankdat.com/stats/a',
        'https://gankdat.com/stats/a',
        'https://gankdat.com/stats/b',
      ],
      fetchImpl,
    });
    expect(result).toEqual({ urls: 2, status: 202, calls: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(INDEXNOW_ENDPOINT);
    expect(calls[0]?.body).toEqual({
      host: 'gankdat.com',
      key,
      keyLocation: `https://gankdat.com/${key}.txt`,
      urlList: ['https://gankdat.com/stats/a', 'https://gankdat.com/stats/b'],
    });
  });

  it('chunks long lists and stops after a rejection', async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://gankdat.com/stats/${i}`);
    const accepted = recorder(200);
    expect(
      await postIndexNow({
        baseUrl: 'https://gankdat.com',
        key,
        urls,
        fetchImpl: accepted.fetchImpl,
        maxPerCall: 2,
      }),
    ).toEqual({ urls: 5, status: 200, calls: 3 });
    expect(accepted.calls.map((c) => c.body.urlList.length)).toEqual([2, 2, 1]);
    const throttled = recorder(429);
    expect(
      await postIndexNow({
        baseUrl: 'https://gankdat.com',
        key,
        urls,
        fetchImpl: throttled.fetchImpl,
        maxPerCall: 2,
      }),
    ).toEqual({ urls: 5, status: 429, calls: 1 });
  });

  it('sends nothing without a well-formed key or any URL, and survives a network error', async () => {
    const { calls, fetchImpl } = recorder();
    expect(
      await postIndexNow({ baseUrl: 'https://gankdat.com', key: '', urls: ['x'], fetchImpl }),
    ).toEqual({
      urls: 0,
      status: null,
      calls: 0,
    });
    expect(
      await postIndexNow({ baseUrl: 'https://gankdat.com', key, urls: [], fetchImpl }),
    ).toEqual({
      urls: 0,
      status: null,
      calls: 0,
    });
    expect(calls).toHaveLength(0);
    const failing = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    expect(
      await postIndexNow({ baseUrl: 'https://gankdat.com', key, urls: ['x'], fetchImpl: failing }),
    ).toEqual({
      urls: 1,
      status: 0,
      calls: 1,
    });
  });
});

function demo(slug: string, fail: boolean): DataSource {
  const source: DataSource<{ id: number }> = {
    slug,
    title: slug,
    description: slug,
    recordSchema: z.object({ id: z.number() }),
    queryParams: z.object({}),
    refresh: { cron: '0 5 * * *', cacheTtlSeconds: 60 },
    fetchFresh(): Promise<{ id: number }[]> {
      return fail ? Promise.reject(new Error('origin 500')) : Promise.resolve([{ id: 1 }]);
    },
  };
  return source as DataSource;
}

describe('refreshOne', () => {
  it('reports whether the source refreshed, so a wave can tell a failed source apart', async () => {
    expect(await refreshOne(env, demo('indexnow-ok', false), Date.now(), 0)).toBe(true);
    expect(await refreshOne(env, demo('indexnow-fail', true), Date.now(), 0)).toBe(false);
  });
});
