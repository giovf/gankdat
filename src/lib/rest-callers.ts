// Who calls the REST data routes — the `rest 7d by UA:` clause of the Daily numbers row (gankdat
// `rest-callers-by-user-agent-reading`, 2026-10-25). The Excel add-in's and the Power Platform
// connector's proofs both read "user agents on `rest_data`", and until now the row read REST only
// by slug (`datasets 30d`) and by account (`datasets 30d external`); the change feeds had the only
// user-agent reading. The grouped read (authed `rest_data` points of the last 7 days, internal
// accounts and the probes excluded in SQL) is rendered per UA family with the number of datasets
// it touched and, when the agent names itself a probe, that too — the clause lists what arrives,
// it never guesses a vendor's string. Pure functions only (Workers-pool tests + metrics.mjs).

import { isProberUa, uaFamily } from './x402-sales.ts';

export interface RestCallRow {
  /** User agent (blob2). */
  ua: string | null;
  /** Source slug (blob5). */
  slug: string | null;
  n: number | string;
}

export const REST_UA_TOP = 8;

const whole = (value: number | string): number => Math.max(0, Math.round(Number(value) || 0));

/**
 * `rest 7d by UA: python-requests 12 (3 datasets), azure-logic-apps 2 (1 dataset), SettledScout 1
 * (1 dataset, prober) +2 more` — most calls first, the top `REST_UA_TOP` families named; `none`
 * when the window had no external call, `n/a` when the read failed.
 */
export function restByUaNote(rows: RestCallRow[] | null, top = REST_UA_TOP): string {
  const head = 'rest 7d by UA';
  if (!rows) return `${head}: n/a`;
  const callers = new Map<string, { n: number; slugs: Set<string>; prober: boolean }>();
  for (const r of rows) {
    const n = whole(r.n);
    if (n === 0) continue;
    const family = uaFamily(r.ua);
    const entry = callers.get(family) ?? { n: 0, slugs: new Set<string>(), prober: false };
    entry.n += n;
    if (r.slug) entry.slugs.add(r.slug);
    entry.prober ||= isProberUa(r.ua);
    callers.set(family, entry);
  }
  if (callers.size === 0) return `${head}: none`;
  const sorted = [...callers].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
  const text = sorted
    .slice(0, top)
    .map(([family, e]) => {
      const datasets = `${e.slugs.size} dataset${e.slugs.size === 1 ? '' : 's'}`;
      return `${family} ${e.n} (${datasets}${e.prober ? ', prober' : ''})`;
    })
    .join(', ');
  const more = sorted.length - top;
  return `${head}: ${text}${more > 0 ? ` +${more} more` : ''}`;
}
