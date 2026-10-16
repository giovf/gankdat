import { env } from 'cloudflare:test';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { isTransientD1Error, refreshOne } from '../src/sources/store';
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
