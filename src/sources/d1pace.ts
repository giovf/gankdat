/**
 * D1's per-database throttle, seen from 2026-10-28 and every night from 2026-11-04:
 * `D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window`.
 * It is raised against whichever statement crosses the line — the wave's (seq, id, hash) index
 * read of a 613k-row register, a cold-key auth read, the second page of a full-register scan —
 * and every statement of the next moments fails the same way (on 2026-11-05 the 05:30, 05:45
 * and 06:05 waves each lost the index read, the full-reload fallback's first statement AND the
 * refresh_log error row within the same second, so the night left no row at all). A retry is
 * only worth anything once the window has passed. This module is the one place that
 * recognises the message, paces the big reads and waits the window out.
 */

/** The throttle's window. */
export const D1_WINDOW_MS = 10_000;
/** A little over the window, so a retry lands in a fresh one. */
export const D1_OVERLOAD_WAIT_MS = 12_000;
/** What a client is told to wait before repeating a request the throttle refused (seconds). */
export const D1_OVERLOAD_RETRY_AFTER_S = 11;

/** Pacing knobs and the clock, mutable so the spec can shrink the page and stub the waits. */
export const d1Pace = {
  /**
   * Rows per page of the stored index. 50,000 wide rows a page, pages back to back, crossed the
   * line at ~160k rows (uk-trademark-journal, 11 s into its wave) and at the first page after
   * another register's pass (uk-care-locations).
   */
  indexPage: 10_000,
  /** Pause after each full index page: at most ~40,000 rows read per window, 2.5× under the lowest trip seen. */
  indexPauseMs: 2_500,
  /** Throttle hits one index read may absorb before the night is given up (each costs D1_OVERLOAD_WAIT_MS). */
  indexMaxTrips: 4,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Both wordings D1 uses ("Too many resources consumed within a 10 second window", "Requests queued for too long"). */
export function isD1Overloaded(err: unknown): boolean {
  return /D1 DB is overloaded/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Runs `fn`; when the throttle refuses it, waits the window out and runs it again, up to
 * `retries` times. For statements that are safe to repeat: a single INSERT/UPDATE (atomic in
 * SQLite, nothing written when it threw) or a `batch` (one transaction).
 */
export async function withOverloadRetry<T>(
  fn: () => Promise<T>,
  retries = 1,
  onRetry?: (attempt: number) => void,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isD1Overloaded(err) || attempt > retries) throw err;
      onRetry?.(attempt);
      await d1Pace.sleep(D1_OVERLOAD_WAIT_MS);
    }
  }
}
