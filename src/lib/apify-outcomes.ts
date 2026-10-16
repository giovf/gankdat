// Apify run outcomes (2026-10-11, queue apify-run-outcomes-reading). Both "under maintenance"
// flags so far (uk-planning-applications 2026-09-25, uk-no-website-leads 2026-10-10) reached
// the repo through Apify's mail after three days of failed runs, while the Daily numbers row's
// `apify 30d by actor` counted those runs as use — it read the count and never the outcome.
// Each actor's own endpoint carries `stats.publicActorRunStats30Days` (every account's runs of it
// in the last 30 days, Apify's QA runner included, by status), so the row now prints a
// `(F failed)` suffix per actor and lists an actor under `refresh errors` as `apify-<name>` when
// its failed count ROSE since the previous row — failures happening now, not history: a fixed
// actor drops out the next day, the 30-day window rolling old failures off never flags, and the
// first row after this ships (no baseline) flags nothing. scripts/refresh-errors-to-queue.ts
// then files `refresh-apify-<name>` by its two-rows-in-four rule, a day before Apify writes.
// Pure functions; read by scripts/metrics.mjs (Node runs the .ts directly — erasable syntax only).

export interface ActorRunStats30Days {
  SUCCEEDED?: number;
  FAILED?: number;
  'TIMED-OUT'?: number;
  ABORTED?: number;
  TOTAL?: number;
}

/** One actor's 30-day reading: `n` runs by other accounts, `total` by every account, `failed` of those. */
export interface ActorOutcome {
  name: string;
  n: number;
  total: number;
  failed: number;
}

export interface ApifyRefreshError {
  source_slug: string;
  message: string;
}

/** Runs that ended badly in the last 30 days: failed or timed out (an abort is the user's own). */
export function failedCount(stats: ActorRunStats30Days | undefined): number {
  return Math.round(Number(stats?.FAILED ?? 0)) + Math.round(Number(stats?.['TIMED-OUT'] ?? 0));
}

/** `apify 30d by actor: a 16, b 11 (2 failed); 0: c, d` — the suffix only where failures exist. */
export function byActorNote(actors: ActorOutcome[], ownRunsKnown: boolean): string {
  const sorted = [...actors].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const label = (a: ActorOutcome): string =>
    `${a.name} ${a.n}${a.failed > 0 ? ` (${a.failed} failed)` : ''}`;
  const used = sorted.filter((a) => a.n > 0 || a.failed > 0).map(label);
  const zero = sorted.filter((a) => a.n === 0 && a.failed === 0).map((a) => a.name);
  return `apify 30d by actor${ownRunsKnown ? '' : ' (all accounts)'}: ${used.length ? used.join(', ') : 'none'}${zero.length ? `; 0: ${zero.join(', ')}` : ''}`;
}

/**
 * Failed count per actor from the Daily numbers row immediately before `date` (today's row is
 * skipped: a re-run must not be its own baseline). null when that row carries no per-actor
 * reading (apify n/a, or a row older than the reading) — then nothing is flagged.
 */
export function previousFailed(researchMd: string, date: string): Map<string, number> | null {
  const rows = (researchMd.match(/^\| \d{4}-\d{2}-\d{2} \| Daily numbers \|.*$/gm) ?? []).reverse();
  for (const row of rows) {
    if (row.startsWith(`| ${date} `)) continue;
    const m = row.match(/apify 30d by actor(?: \(all accounts\))?: (.*?)(?:; 0: [^;|]*)?(?:;|\|)/);
    if (!m?.[1]) return null;
    const out = new Map<string, number>();
    for (const part of m[1].split(', ')) {
      const p = part.trim().match(/^([a-z0-9-]+) \d+(?: \((\d+) failed\))?$/);
      if (p?.[1]) out.set(p[1], Number(p[2] ?? 0));
    }
    return out;
  }
  return null;
}

/** Actors whose failed count rose since the previous row, as `refresh errors` entries. */
export function newlyFailing(
  today: ActorOutcome[],
  previous: Map<string, number> | null,
): ApifyRefreshError[] {
  if (!previous) return [];
  return today
    .filter((a) => a.failed > (previous.get(a.name) ?? 0))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({
      source_slug: `apify-${a.name}`,
      message: `${a.failed - (previous.get(a.name) ?? 0)} new failed run(s) since the last row, ${a.failed} of ${a.total} in 30 d`,
    }));
}
