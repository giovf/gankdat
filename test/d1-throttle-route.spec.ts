import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { ErrorEnvelope } from '../src/lib/envelope';
import { D1_OVERLOAD_RETRY_AFTER_S } from '../src/sources/d1pace';
import { bearer, issueKey } from './helpers/auth';

// A data read that D1's 10-second throttle refuses (d1pace.ts) answers 503 WITH a Retry-After
// header, so a client waits the window out instead of retrying into it: on 2026-11-04 the Apify
// QA run's second page of uk-food-hygiene (a 7 s full-register scan) was refused, its 2 s / 4 s
// retries met the same window, and Apify flagged the actor "under maintenance".

const OVERLOADED =
  'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window';

/** The real database behind a façade whose source_meta read rejects once with the throttle. */
function throttledEnv(): CloudflareBindings {
  let fail = 1;
  const db = {
    prepare(sql: string) {
      const stmt = env.DB.prepare(sql);
      if (!sql.includes('FROM source_meta')) return stmt;
      return {
        bind(...values: unknown[]) {
          const bound = stmt.bind(...values);
          return {
            first: <T>(col?: string) => {
              if (fail > 0) {
                fail -= 1;
                return Promise.reject(new Error(OVERLOADED));
              }
              return col ? bound.first<T>(col) : bound.first<T>();
            },
            all: <T>() => bound.all<T>(),
            run: () => bound.run(),
          };
        },
      };
    },
    batch: <T>(statements: D1PreparedStatement[]) => env.DB.batch<T>(statements),
    exec: (query: string) => env.DB.exec(query),
  };
  return { ...env, DB: db as unknown as D1Database };
}

describe('GET /v1/data/:source under the D1 throttle', () => {
  it('answers 503 with Retry-After and a "busy" message, not the plain unavailable one', async () => {
    const { key } = await issueKey();
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request('https://example.com/v1/data/uk-food-hygiene?per_page=1', {
        headers: bearer(key),
      }),
      throttledEnv(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe(String(D1_OVERLOAD_RETRY_AFTER_S));
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('unavailable');
    expect(body.error.message).toBe(
      `Source 'uk-food-hygiene' is busy, retry in ${D1_OVERLOAD_RETRY_AFTER_S} s`,
    );
  });
});
