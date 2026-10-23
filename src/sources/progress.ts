/**
 * Refresh progress marker (2026-10-18, gankdat `refresh-uk-trademark-journal-2026-10-17`).
 *
 * A wave the platform kills — the 15-minute Cron Trigger wall limit, the 300 s CPU limit, memory —
 * runs no `catch`, so the night leaves no `refresh_log` row and nothing in the repo says where it
 * died: uk-trademark-journal's wave 7 wrote nothing on 10-05/06, 10-08/09, 10-11/12/13 and
 * 10-15/16, and each streak was guessed at. Worker logs are no help either: the observability
 * query the metrics runner sends (`lib/wave-logs.ts`) returned not one line from any cron wave on
 * 10-16, for sources that verifiably refreshed, so "no invocation" there is not evidence.
 *
 * So the refresh itself leaves a trail the next wave can read: `refreshOne` puts
 * `refresh:progress:<slug>` at the start of every attempt, the store paths overwrite it at each
 * phase (`index`, `stream N records`, `written`, `stats`), and the marker is deleted once the
 * attempt has written its own row. A marker still there when the next attempt starts means the
 * previous one died silently: that attempt writes the missing `error` row first — status, phase,
 * elapsed, when it started — so every night has a row and the Daily numbers reading names the
 * phase instead of `no successful refresh since …`.
 *
 * KV allows one write a second per key, so marks closer than that are skipped (best-effort, the
 * phase before stands) and the delete waits for the gap. Dataset-agnostic: nothing here knows a
 * source beyond its slug.
 */

export const progressKey = (slug: string): string => `refresh:progress:${slug}`;
/** A marker outlives any wave by days, so a trigger that stops firing still leaves the last one readable. */
export const PROGRESS_TTL_SECONDS = 3 * 86_400;
/** Writes to one KV key are limited to one a second. */
export const PROGRESS_MIN_GAP_MS = 1_000;

export interface RefreshProgress {
  /** When the attempt started (ISO). */
  started_at: string;
  /** The last phase the attempt reached: start, backfill, index, stream, written, stats. */
  phase: string;
  /** Free text for the phase, e.g. `120000 records`. */
  detail: string | null;
  /** Milliseconds into the attempt when the phase was reached. */
  elapsed_ms: number;
  /** When the mark was written (ISO). */
  at: string;
}

/** Injectable for tests: the clock, the same-key gap and how to wait for it. */
export const progressConfig = {
  now: (): number => Date.now(),
  minGapMs: PROGRESS_MIN_GAP_MS,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

const lastPutAt = new Map<string, number>();

/** Records the phase an attempt has reached; skipped when the key was written under a second ago. Never throws. */
export async function markRefreshProgress(
  env: CloudflareBindings,
  slug: string,
  startedAt: number,
  phase: string,
  detail: string | null = null,
): Promise<boolean> {
  const now = progressConfig.now();
  const last = lastPutAt.get(slug);
  if (phase !== 'start' && last !== undefined && now - last < progressConfig.minGapMs) return false;
  const progress: RefreshProgress = {
    started_at: new Date(startedAt).toISOString(),
    phase,
    detail,
    elapsed_ms: Math.max(0, now - startedAt),
    at: new Date(now).toISOString(),
  };
  try {
    await env.CACHE.put(progressKey(slug), JSON.stringify(progress), {
      expirationTtl: PROGRESS_TTL_SECONDS,
    });
    lastPutAt.set(slug, now);
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'refresh_progress_failed',
        source: slug,
        phase,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}

/** The marker a previous attempt left, or null. Never throws. */
export async function readRefreshProgress(
  env: CloudflareBindings,
  slug: string,
): Promise<RefreshProgress | null> {
  try {
    const raw = await env.CACHE.get<RefreshProgress>(progressKey(slug), 'json');
    if (!raw || typeof raw !== 'object' || typeof raw.phase !== 'string') return null;
    return {
      started_at: typeof raw.started_at === 'string' ? raw.started_at : '',
      phase: raw.phase,
      detail: typeof raw.detail === 'string' ? raw.detail : null,
      elapsed_ms: typeof raw.elapsed_ms === 'number' ? raw.elapsed_ms : 0,
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  } catch {
    return null;
  }
}

/**
 * Deletes the marker once the attempt has written its own refresh_log row. A delete that fails is
 * retried once after the same-key gap (2026-10-23, refresh-marker-false-positive): a marker left
 * behind reads as a death the next night, so one lost delete is worth a second try. Never throws.
 */
export async function clearRefreshProgress(env: CloudflareBindings, slug: string): Promise<void> {
  const last = lastPutAt.get(slug);
  if (last !== undefined) {
    const wait = progressConfig.minGapMs - (progressConfig.now() - last);
    if (wait > 0) await progressConfig.sleep(wait);
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await env.CACHE.delete(progressKey(slug));
      lastPutAt.delete(slug);
      return;
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'refresh_progress_clear_failed',
          source: slug,
          attempt,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      if (attempt === 2) return;
      await progressConfig.sleep(progressConfig.minGapMs);
    }
  }
}

/**
 * The refresh_log message for a night that died silently. One line without parentheses or pipes:
 * the Daily numbers row and `refresh-errors-to-queue` split on those.
 */
export function silentRefreshMessage(progress: RefreshProgress): string {
  const started = progress.started_at.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const seconds = Math.round(progress.elapsed_ms / 1000);
  const detail = progress.detail ? ` ${progress.detail}` : '';
  return `silent refresh started ${started} died after ${progress.phase}${detail} at ${seconds} s, no row written`;
}
