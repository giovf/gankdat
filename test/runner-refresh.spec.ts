import { env } from 'cloudflare:test';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCached, readSnapshot, readSourceStats, snapshotWrites } from '../src/sources/cache';
import { cronSources, isRunnerFed } from '../src/sources/store';
import type { DataSource } from '../src/sources/types';

// A runner-fed source (`refresh.runner`): the Worker's cron waves leave it alone, a stale KV
// snapshot is served as is (the GitHub runner owns freshness), and the runner writes exactly the
// two KV values the Worker's own refresh would have — so the public surface cannot tell them apart.

function runnerSource(
  slug: string,
  records: { id: number }[],
): DataSource & { calls: () => number } {
  let calls = 0;
  const source: DataSource<{ id: number }> = {
    slug,
    title: slug,
    description: slug,
    recordSchema: z.object({ id: z.number() }),
    queryParams: z.object({}),
    refresh: { cron: '0 5 * * *', cacheTtlSeconds: 60, runner: true },
    fetchFresh(): Promise<{ id: number }[]> {
      calls += 1;
      return Promise.resolve(records);
    },
  };
  return Object.assign(source as DataSource, { calls: () => calls });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runner-fed sources', () => {
  it('are left out of every cron wave while the other sources stay in', () => {
    const slugs = (wave: 1 | undefined): string[] => cronSources(wave).map((s) => s.slug);
    expect(slugs(1)).toContain('uk-tenders');
    expect(slugs(1)).not.toContain('uk-insolvency');
    expect(slugs(undefined)).not.toContain('uk-insolvency');
    expect(cronSources(undefined).some(isRunnerFed)).toBe(false);
  });

  it('serve a stale snapshot without touching the origin, and still refresh a cold cache', async () => {
    const source = runnerSource('runner-stale', [{ id: 1 }]);
    const stale = { records: [{ id: 99 }], last_refreshed_at: '2026-01-01T00:00:00.000Z' };
    await env.CACHE.put(`data:${source.slug}`, JSON.stringify(stale));
    expect(await readCached(env, source)).toEqual(stale);
    expect(source.calls()).toBe(0);

    const cold = runnerSource('runner-cold', [{ id: 2 }]);
    const payload = await readCached(env, cold);
    expect(payload.records).toEqual([{ id: 2 }]);
    expect(cold.calls()).toBe(1);
  });

  it('runner writes read back as the snapshot and the stats blob the Worker serves', async () => {
    const source = runnerSource('runner-writes', []);
    const records = [{ id: 1 }, { id: 1 }, { id: 2 }];
    const writes = snapshotWrites(source, records, '2026-10-04T06:30:00.000Z');
    expect(writes.map((w) => w.key)).toEqual(['data:runner-writes', 'srcstats:runner-writes']);
    expect(writes.every((w) => w.ttl === 60 * 7)).toBe(true);
    for (const w of writes) await env.CACHE.put(w.key, w.value, { expirationTtl: w.ttl });
    expect(await readSnapshot(env, source.slug)).toEqual({
      records,
      last_refreshed_at: '2026-10-04T06:30:00.000Z',
    });
    const stats = await readSourceStats(env, source.slug);
    expect(stats?.last_refreshed_at).toBe('2026-10-04T06:30:00.000Z');
    expect(stats?.stats.total).toBe(3);
  });
});
