/**
 * When a source's daily Cron Trigger next fires (gankdat `stats-page-before-first-load`,
 * 2026-11-18). Pure: a `M H * * *` cron and a clock in, the next run and the seconds to it out;
 * null for a cron of any other shape (the caller falls back to an hour).
 */
export interface NextWave {
  /** `HH:MM`, UTC. */
  at: string;
  /** Whether that run is today (UTC) or tomorrow. */
  day: 'today' | 'tomorrow';
  /** Seconds from `nowMs` to the run. */
  inSeconds: number;
}

const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;

export function nextWave(cron: string | null, nowMs: number): NextWave | null {
  const match = cron === null ? null : DAILY_CRON.exec(cron.trim());
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const now = new Date(nowMs);
  const todayRun = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hour,
    minute,
  );
  const today = todayRun > nowMs;
  const run = today ? todayRun : todayRun + 24 * 60 * 60 * 1000;
  return {
    at: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    day: today ? 'today' : 'tomorrow',
    inSeconds: Math.ceil((run - nowMs) / 1000),
  };
}
