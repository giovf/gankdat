import { env } from 'cloudflare:test';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  dataKey,
  retainSnapshot,
  snapshotTtlSeconds,
  snapshotWrites,
  statsKey,
} from '../src/sources/cache';
import { isTransientD1Error, refreshOne, unavailableMessage } from '../src/sources/store';
import type { DataSource } from '../src/sources/types';

// A refresh that dies on a transient D1 error ("internal error; reference = …",
// "Network connection lost") is retried once while the wave is young; anything
// else fails once and the wave moves on.

function flaky(slug: string, failures: Error[]): { source: DataSource; calls: () => number } {
  let calls = 0;
  const source: DataSource<{ id: number }> = {
    slug,
    title: slug,
    description: slug,
    recordSchema: z.object({ id: z.number() }),
    queryParams: z.object({}),
    refresh: { cron: '0 5 * * *', cacheTtlSeconds: 60 },
    fetchFresh(): Promise<{ id: number }[]> {
      calls += 1;
      const err = failures.shift();
      return err ? Promise.reject(err) : Promise.resolve([{ id: calls }]);
    },
  };
  return { source: source as DataSource, calls: () => calls };
}

async function statuses(slug: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT status FROM refresh_log WHERE source_slug = ?1 ORDER BY rowid',
  )
    .bind(slug)
    .all<{ status: string }>();
  return (rows.results ?? []).map((r) => r.status);
}

describe('refreshOne', () => {
  it('recognises the transient D1 messages', () => {
    expect(
      isTransientD1Error(
        new Error('D1_ERROR: internal error; reference = pvpjl6o7idm7cdijf25nr275'),
      ),
    ).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: Network connection lost.'))).toBe(true);
    expect(isTransientD1Error(new Error('refresh returned 0 records'))).toBe(false);
    expect(isTransientD1Error(new Error('D1_ERROR: string or blob too big'))).toBe(false);
  });

  it('retries once on a transient D1 error and records the recovery', async () => {
    const { source, calls } = flaky('retry-once', [
      new Error('D1_ERROR: internal error; reference = abc'),
    ]);
    await refreshOne(env, source, Date.now(), 0);
    expect(calls()).toBe(2);
    expect(await statuses('retry-once')).toEqual(['error', 'ok']);
  });

  it('does not retry a data error, a second transient failure, or once the wave is old', async () => {
    const data = flaky('no-retry-data', [new Error('origin responded 500')]);
    await refreshOne(env, data.source, Date.now(), 0);
    expect(data.calls()).toBe(1);

    const twice = flaky('no-retry-twice', [
      new Error('D1_ERROR: Network connection lost.'),
      new Error('D1_ERROR: Network connection lost.'),
    ]);
    await refreshOne(env, twice.source, Date.now(), 0);
    expect(twice.calls()).toBe(2);
    expect(await statuses('no-retry-twice')).toEqual(['error', 'error']);

    const late = flaky('no-retry-late', [new Error('D1_ERROR: internal error; reference = x')]);
    await refreshOne(env, late.source, Date.now() - 10 * 60_000, 0);
    expect(late.calls()).toBe(1);
  });
});

describe('retainSnapshot', () => {
  it('keeps the last snapshot and stats blob alive, byte for byte, when the refresh fails', async () => {
    const { source } = flaky('retain-kv', [new Error('origin dataset empty: count 0')]);
    const writes = snapshotWrites(source, [{ id: 7 }], '2026-10-09T05:01:52.000Z');
    for (const w of writes) await env.CACHE.put(w.key, w.value, { expirationTtl: w.ttl });
    const put = vi.spyOn(env.CACHE, 'put');
    expect(await refreshOne(env, source, Date.now(), 0)).toBe(false);
    const ttl = snapshotTtlSeconds(source);
    const touched = put.mock.calls.map((c) => [
      c[0],
      (c[2] as { expirationTtl?: number }).expirationTtl,
    ]);
    expect(touched).toEqual([
      [dataKey('retain-kv'), ttl],
      [statsKey('retain-kv'), ttl],
    ]);
    expect(await env.CACHE.get(dataKey('retain-kv'))).toBe(writes[0]!.value);
    expect(await env.CACHE.get(statsKey('retain-kv'))).toBe(writes[1]!.value);
    expect(await statuses('retain-kv')).toEqual(['error']);
    put.mockRestore();
  });

  it('is a no-op without a snapshot', async () => {
    const { source } = flaky('retain-none', []);
    expect(await retainSnapshot(env, source)).toBe(false);
    expect(await env.CACHE.get(dataKey('retain-none'))).toBeNull();
  });
});

describe('unavailableMessage', () => {
  it('names the origin notice when the source has one, else says retry later', () => {
    const { source } = flaky('msg', []);
    expect(unavailableMessage(source)).toBe("Source 'msg' is temporarily unavailable, retry later");
    expect(unavailableMessage({ ...source, notice: 'Origin paused since 2026-10-10.' })).toBe(
      "Source 'msg' is unavailable: Origin paused since 2026-10-10.",
    );
  });
});
