// Who calls the change feed — the `changes 7d by UA:` clause of the Daily numbers row (gankdat
// `x402-buyer-vs-survey-split`, 2026-10-25). `changes 7d: 4 (mcp 0, rest 4)` since 10-21 was the
// first non-zero change-feed reading after 20 daily rows at 0, and nothing said who made the
// calls: STRATEGY §4's weekly target would count a scanner's sweep as a watcher. The grouped read
// (`mcp_authed` get_changes calls and `rest_changes` points, probes excluded in SQL) is rendered
// per UA family with the surface and, when the agent names itself a probe, that too. Pure
// functions only, so the Workers-pool tests import them and `scripts/metrics.mjs` renders them.

import { isProberUa, uaFamily } from './x402-sales';

export interface ChangeCallRow {
  /** `mcp_authed` or `rest_changes` (blob1). */
  kind: string | null;
  /** User agent (blob2). */
  ua: string | null;
  n: number | string;
}

const whole = (value: number | string): number => Math.max(0, Math.round(Number(value) || 0));

const surface = (kind: string | null): string => (kind === 'mcp_authed' ? 'mcp' : 'rest');

/**
 * `changes 7d by UA: python-requests 3 (rest), SettledScout 1 (rest, prober)`, most calls first;
 * `none` when the window had no call, `n/a` when the read failed.
 */
export function changesByUaNote(rows: ChangeCallRow[] | null): string {
  const head = 'changes 7d by UA';
  if (!rows) return `${head}: n/a`;
  const callers = new Map<string, { n: number; surfaces: Set<string>; prober: boolean }>();
  for (const r of rows) {
    const n = whole(r.n);
    if (n === 0) continue;
    const family = uaFamily(r.ua);
    const entry = callers.get(family) ?? { n: 0, surfaces: new Set<string>(), prober: false };
    entry.n += n;
    entry.surfaces.add(surface(r.kind));
    entry.prober ||= isProberUa(r.ua);
    callers.set(family, entry);
  }
  if (callers.size === 0) return `${head}: none`;
  const text = [...callers]
    .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))
    .map(([family, e]) => {
      const tags = [...e.surfaces].sort().concat(e.prober ? ['prober'] : []);
      return `${family} ${e.n} (${tags.join(', ')})`;
    })
    .join(', ');
  return `${head}: ${text}`;
}
