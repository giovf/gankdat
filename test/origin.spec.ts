import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { refreshSource } from '../src/sources/cache';
import { refreshD1Source } from '../src/sources/d1store';
import { describeBody, originFetch, traceOrigin, zeroRecordsError } from '../src/sources/origin';
import type { DataSource } from '../src/sources/types';

// refresh-zero-records-evidence (2026-10-11): a refresh that yields nothing fails with the
// first page the origin served — URL, status, bytes, shape — so the Daily numbers row tells an
// emptied dataset from a 5xx page. The fixture origin is the relay reading of 2026-10-11
// (gankdat-research-2026-10-11/1.json): planning.data.gov.uk page 1 answering 200 with
// `{"entities":[],"links":{},"count":0}` — 36 bytes.

const PAGE_URL =
  'https://www.planning.data.gov.uk/entity.json?dataset=planning-application&limit=500&offset=0';
const EMPTY_PAGE = '{"entities":[],"links":{},"count":0}';
const FULL_PAGE = JSON.stringify({
  entities: [
    { entity: 1, reference: 'A/1' },
    { entity: 2, reference: 'A/2' },
  ],
  links: {},
  count: 2,
});

function stubOrigin(body: string, init?: ResponseInit): void {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, init)));
}

async function lastLog(slug: string): Promise<{ status: string; message: string | null }> {
  const row = await env.DB.prepare(
    'SELECT status, message FROM refresh_log WHERE source_slug = ?1 ORDER BY rowid DESC LIMIT 1',
  )
    .bind(slug)
    .first<{ status: string; message: string | null }>();
  if (!row) throw new Error('no refresh_log row');
  return row;
}

const recordSchema = z.object({ entity: z.number(), reference: z.string() });
type Rec = z.infer<typeof recordSchema>;

async function readPage(): Promise<Rec[]> {
  const res = await originFetch(PAGE_URL, { headers: { accept: 'application/json' } });
  const page = z.object({ entities: z.array(recordSchema) }).parse(await res.json());
  return page.entities;
}

function source(slug: string, storage?: 'd1'): DataSource {
  const s: DataSource<Rec> = {
    slug,
    title: slug,
    description: slug,
    recordSchema,
    queryParams: z.object({}),
    refresh: { cron: '0 5 * * *', cacheTtlSeconds: 60 },
    fetchFresh: readPage,
    ...(storage ? { storage, idOf: (r: Rec) => String(r.entity) } : {}),
  };
  return s as DataSource;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('originFetch + zeroRecordsError', () => {
  it('names the first page: method, status, bytes, JSON keys and URL', async () => {
    stubOrigin(EMPTY_PAGE, { headers: { 'content-type': 'application/json' } });
    const err = await traceOrigin(async () => {
      const page = await readPage();
      expect(page).toEqual([]);
      return zeroRecordsError();
    });
    expect(err.message).toBe(
      `refresh returned 0 records: GET 200 36 B keys entities,links,count from ${PAGE_URL}`,
    );
    // The row parser splits entries on commas outside parentheses: none in the message.
    expect(err.message).not.toMatch(/[()|]/);
  });

  it('keeps the body readable and counts further pages', async () => {
    stubOrigin(EMPTY_PAGE);
    const err = await traceOrigin(async () => {
      await readPage();
      await readPage();
      await readPage();
      return zeroRecordsError();
    });
    expect(err.message).toContain('; 3 pages, last GET 200 36 B keys entities,links,count');
  });

  it('shows a non-JSON page as its status and first characters', async () => {
    stubOrigin('<html><body>Service Unavailable (maintenance) | try later</body></html>', {
      status: 503,
      headers: { 'content-type': 'text/html' },
    });
    const err = await traceOrigin(async () => {
      await originFetch(PAGE_URL);
      return zeroRecordsError();
    });
    expect(err.message).toBe(
      `refresh returned 0 records: GET 503 71 B text <html><body>Service Unavailable _maintenance_ _ try later</body></html> from ${PAGE_URL}`,
    );
  });

  it('peeks a body longer than the window without consuming it', async () => {
    const big = JSON.stringify({ entities: Array.from({ length: 2000 }, (_, i) => ({ i })) });
    stubOrigin(big);
    const err = await traceOrigin(async () => {
      const res = await originFetch(PAGE_URL);
      expect((await res.text()).length).toBe(big.length);
      return zeroRecordsError();
    });
    expect(err.message).toContain(`>=4.0 kB text {"entities":[{"i":0},`);
  });

  it('says so when the source never went through originFetch', async () => {
    const err = await traceOrigin(async () => zeroRecordsError());
    expect(err.message).toBe('refresh returned 0 records: no origin page seen');
    expect(zeroRecordsError().message).toBe('refresh returned 0 records: no origin page seen');
  });

  it('describeBody: object keys, array length, empty, long text', () => {
    expect(describeBody('{"a":1,"b":[],"c":null}', true)).toBe('keys a,b,c');
    expect(describeBody('[1,2,3]', true)).toBe('array[3]');
    expect(describeBody('{}', true)).toBe('keys none');
    expect(describeBody('   ', true)).toBe('empty body');
    expect(describeBody('{"a":1', false)).toBe('text {"a":1');
    expect(describeBody('x'.repeat(100), true)).toBe(`text ${'x'.repeat(80)}…`);
    const many = JSON.stringify(Object.fromEntries('abcdefghij'.split('').map((k) => [k, 1])));
    expect(describeBody(many, true)).toBe('keys a,b,c,d,e,f,g,h,+2');
  });
});

describe('KV store', () => {
  it('refreshSource fails with the origin page and logs it', async () => {
    stubOrigin(EMPTY_PAGE);
    const src = source('origin-kv');
    await expect(refreshSource(env, src)).rejects.toThrow(
      `refresh returned 0 records: GET 200 36 B keys entities,links,count from ${PAGE_URL}`,
    );
    const log = await lastLog('origin-kv');
    expect(log.status).toBe('error');
    expect(log.message).toContain('keys entities,links,count');
  });
});

describe('D1 store', () => {
  it('full and delta refreshes fail with the origin page and keep the stored generation', async () => {
    const src = source('origin-d1', 'd1');
    stubOrigin(EMPTY_PAGE);
    // First load (no previous generation): the full path.
    await expect(refreshD1Source(env, src)).rejects.toThrow(
      `refresh returned 0 records: GET 200 36 B keys entities,links,count from ${PAGE_URL}`,
    );
    expect((await lastLog('origin-d1')).message).toContain('from https://www.planning.data.gov.uk');

    stubOrigin(FULL_PAGE);
    const meta = await refreshD1Source(env, src);
    expect(meta.total).toBe(2);

    // Second load with an index to compare against: the delta path.
    stubOrigin(EMPTY_PAGE);
    await expect(refreshD1Source(env, src)).rejects.toThrow(
      'GET 200 36 B keys entities,links,count',
    );
    const kept = await env.DB.prepare('SELECT total FROM source_meta WHERE source_slug = ?1')
      .bind('origin-d1')
      .first<{ total: number }>();
    expect(kept?.total).toBe(2);
  });
});
