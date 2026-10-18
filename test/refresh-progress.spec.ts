import { env } from 'cloudflare:test';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRefreshProgress,
  markRefreshProgress,
  progressConfig,
  progressKey,
  readRefreshProgress,
  silentRefreshMessage,
} from '../src/sources/progress';
import { recordSilentRefresh, refreshOne } from '../src/sources/store';
import type { DataSource } from '../src/sources/types';

// A wave the platform kills runs no catch, so the night had no refresh_log row and nothing said
// where it died (uk-trademark-journal, nine silent nights in October). Every attempt now leaves a
// progress marker in KV and clears it once it has written its own row; a marker still there when
// the next attempt starts becomes the missing `error` row, naming the phase.

function source(slug: string): DataSource {
  const src: DataSource<{ id: number }> = {
    slug,
    title: slug,
    description: slug,
    recordSchema: z.object({ id: z.number() }),
    queryParams: z.object({}),
    refresh: { cron: '0 5 * * *', cacheTtlSeconds: 60 },
    fetchFresh: () => Promise.resolve([{ id: 1 }, { id: 2 }]),
  };
  return src as DataSource;
}

async function rows(slug: string): Promise<{ status: string; message: string | null }[]> {
  const res = await env.DB.prepare(
    'SELECT status, message FROM refresh_log WHERE source_slug = ?1 ORDER BY rowid',
  )
    .bind(slug)
    .all<{ status: string; message: string | null }>();
  return res.results ?? [];
}

const realNow = progressConfig.now;
afterEach(() => {
  progressConfig.now = realNow;
  progressConfig.minGapMs = 0;
});

describe('refresh progress marker', () => {
  it('a marker left by the previous attempt becomes the row that night never wrote', async () => {
    const started = Date.parse('2026-10-15T06:05:03Z');
    await env.CACHE.put(
      progressKey('journal-like'),
      JSON.stringify({
        started_at: new Date(started).toISOString(),
        phase: 'stream',
        detail: '120000 records',
        elapsed_ms: 612_400,
        at: new Date(started + 612_400).toISOString(),
      }),
    );
    await refreshOne(env, source('journal-like'), Date.now(), 0);
    const log = await rows('journal-like');
    expect(log.map((r) => r.status)).toEqual(['error', 'ok']);
    expect(log[0]?.message).toBe(
      'silent refresh started 2026-10-15 06:05:03Z died after stream 120000 records at 612 s, no row written',
    );
    // The row must survive the Daily numbers parser: no parentheses, no pipes.
    expect(log[0]?.message).not.toMatch(/[()|]/);
    // The marker is gone once this attempt has its own row.
    expect(await env.CACHE.get(progressKey('journal-like'))).toBeNull();
  });

  it('a completed attempt leaves no marker and owes nothing', async () => {
    await refreshOne(env, source('clean-night'), Date.now(), 0);
    expect(await env.CACHE.get(progressKey('clean-night'))).toBeNull();
    expect((await rows('clean-night')).map((r) => r.status)).toEqual(['ok']);
    expect(await recordSilentRefresh(env, 'clean-night')).toBeNull();
    expect((await rows('clean-night')).map((r) => r.status)).toEqual(['ok']);
  });

  it('a failed attempt still clears its marker (its error row is written by the store)', async () => {
    const failing: DataSource = {
      ...source('loud-failure'),
      fetchFresh: () => Promise.reject(new Error('origin responded 500')),
    } as DataSource;
    await refreshOne(env, failing, Date.now(), 0);
    expect(await env.CACHE.get(progressKey('loud-failure'))).toBeNull();
    expect((await rows('loud-failure')).map((r) => r.status)).toEqual(['error']);
  });

  it('marks record the phase and skip writes closer than the KV same-key gap', async () => {
    let now = 1_000_000;
    progressConfig.now = () => now;
    progressConfig.minGapMs = 1_000;
    const start = now;
    expect(await markRefreshProgress(env, 'gap', start, 'start')).toBe(true);
    now += 200;
    expect(await markRefreshProgress(env, 'gap', start, 'index', '5 rows')).toBe(false);
    now += 900;
    expect(await markRefreshProgress(env, 'gap', start, 'stream', '25000 records')).toBe(true);
    const progress = await readRefreshProgress(env, 'gap');
    expect(progress).toMatchObject({
      phase: 'stream',
      detail: '25000 records',
      elapsed_ms: 1_100,
      started_at: new Date(start).toISOString(),
    });
    expect(silentRefreshMessage(progress!)).toBe(
      `silent refresh started ${new Date(start)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d+Z$/, 'Z')} died after stream 25000 records at 1 s, no row written`,
    );
    // The delete waits out the gap rather than failing on it.
    let slept = 0;
    progressConfig.sleep = (ms) => {
      slept += ms;
      now += ms;
      return Promise.resolve();
    };
    await clearRefreshProgress(env, 'gap');
    expect(slept).toBe(1_000);
    expect(await readRefreshProgress(env, 'gap')).toBeNull();
  });

  it('ignores a malformed marker', async () => {
    await env.CACHE.put(progressKey('garbage'), '{"nope":1}');
    expect(await readRefreshProgress(env, 'garbage')).toBeNull();
    expect(await recordSilentRefresh(env, 'garbage')).toBeNull();
  });
});
