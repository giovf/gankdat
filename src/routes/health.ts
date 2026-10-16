import { Hono } from 'hono';
import { APP_VERSION } from '../lib/constants';
import { success } from '../lib/envelope';
import { listSources } from '../sources/registry';
import type { AppEnv } from '../types';

// Data is considered stale after two daily refresh cycles missed.
const STALE_AFTER_HOURS = 48;

interface SourceFreshness {
  slug: string;
  last_refreshed_at: string | null;
  age_hours: number | null;
}

// Liveness + data-freshness. Always 200 if the Worker is up (uptime target);
// `data_fresh` lets a monitor alert on a silently-failing cron/origin without
// eyeballing refresh_log. Freshness is best-effort: a D1 blip reports null, not
// a failed health check.
export const healthRoute = new Hono<AppEnv>().get('/', async (c) => {
  let dataFresh: boolean | null = null;
  let sources: SourceFreshness[] = [];
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT source_slug AS slug, MAX(created_at) AS last_ok FROM refresh_log WHERE status = 'ok' GROUP BY source_slug",
    ).all<{ slug: string; last_ok: string }>();
    const lastBySlug = new Map(results.map((r) => [r.slug, r.last_ok]));
    const now = Date.now();
    sources = listSources().map((s) => {
      const last = lastBySlug.get(s.slug) ?? null;
      // datetime('now') is 'YYYY-MM-DD HH:MM:SS' UTC — make it ISO to parse as UTC.
      const ageH = last ? (now - Date.parse(`${last.replace(' ', 'T')}Z`)) / 3_600_000 : null;
      return {
        slug: s.slug,
        last_refreshed_at: last,
        age_hours: ageH === null ? null : Math.round(ageH * 10) / 10,
      };
    });
    dataFresh = sources.every((s) => s.age_hours !== null && s.age_hours < STALE_AFTER_HOURS);
  } catch {
    // liveness must not depend on D1 — leave data_fresh null (unknown)
  }
  return c.json(success({ status: 'ok', version: APP_VERSION, data_fresh: dataFresh, sources }));
});
