// What sold on the x402 lane — the reading behind the Daily numbers row's `x402 paid` clause
// (gankdat `x402-paid-by-source-reading`, 2026-10-19). Pure functions only, no node builtins, so
// the Workers-pool tests import them and `scripts/metrics.mjs` renders what they return.
//
// Every settled payment writes one `x402_paid` analytics point (`src/x402/routes.ts`): blob2 the
// user agent, blob3 the path, blob5 the source slug, blob6 the hashed client id the preview wall
// also writes (never an IP). The lane's first three external payments (10-17/18) reached the row
// as a bare `3 x402 paid` because the point was read as a count only; now the clause names the
// source, the distinct clients and the UA family, for 24 h and for 30 days. The probe's and the
// owner's own payments (`gankdat-x402-probe/…`) are left out by the SQL, never here.

export interface X402PaidRow {
  slug: string | null;
  ua: string | null;
  /** Hashed client id (blob6); '' when the point predates it. */
  client: string | null;
  n: number | string;
}

export interface X402SalesSummary {
  paid: number;
  clients: number;
  /** Paid calls per source slug, most first. */
  bySlug: [string, number][];
  /** Paid calls per UA family, most first. */
  byFamily: [string, number][];
}

const whole = (value: number | string): number => Math.max(0, Math.round(Number(value) || 0));

/**
 * The product name of a user agent: the first token up to `/`, a space or `(`, so
 * `python-requests/2.34.2` is `python-requests` and `x402-fetch (node)` is `x402-fetch`. Pipes,
 * semicolons and parentheses never reach the row (the refresh-errors parser splits on them).
 */
export function uaFamily(ua: string | null): string {
  const head = (ua ?? '').trim().split(/[\s/(]/, 1)[0] ?? '';
  const clean = head.replace(/[|;()]/g, '').slice(0, 24);
  return clean || '(no UA)';
}

const tally = (rows: X402PaidRow[], key: (r: X402PaidRow) => string): [string, number][] => {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    counts.set(k, (counts.get(k) ?? 0) + whole(r.n));
  }
  return [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};

/** Sums the grouped rows of one window (slug × UA × client). */
export function x402Sales(rows: X402PaidRow[]): X402SalesSummary {
  const paid = rows.reduce((a, r) => a + whole(r.n), 0);
  const clients = new Set(rows.filter((r) => whole(r.n) > 0 && r.client).map((r) => r.client)).size;
  return {
    paid,
    clients,
    bySlug: tally(rows, (r) => r.slug || '(no source)'),
    byFamily: tally(rows, (r) => uaFamily(r.ua)),
  };
}

const list = (pairs: [string, number][]): string => pairs.map(([k, n]) => `${k} ${n}`).join(', ');

/**
 * The row's sales cell: `3 x402 paid (uk-sanctions 2, eu-ted 1; 3 clients; python-requests 2,
 * x402-fetch 1)`; `0 x402 paid` unchanged when nothing sold. `total` is the row's own 24-h count
 * (the `kinds` query); the breakdown is rendered only when the grouped rows agree with it, so a
 * failed or partial grouped read never misstates a sale.
 */
export function x402PaidClause(total: number | string, rows: X402PaidRow[] | null): string {
  const n = whole(total);
  const head = `${n} x402 paid`;
  if (n === 0 || !rows) return head;
  const s = x402Sales(rows);
  if (s.paid !== n) return head;
  return `${head} (${list(s.bySlug)}; ${s.clients} client${s.clients === 1 ? '' : 's'}; ${list(s.byFamily)})`;
}

/** The 30-day note: `x402 30d: 4 paid, 3 clients — uk-sanctions 3, eu-ted 1; python-requests 3, x402-fetch 1`. */
export function x402Paid30dNote(rows: X402PaidRow[] | null): string {
  if (!rows) return 'x402 30d: n/a';
  const s = x402Sales(rows);
  if (s.paid === 0) return 'x402 30d: 0 paid';
  return `x402 30d: ${s.paid} paid, ${s.clients} client${s.clients === 1 ? '' : 's'} — ${list(s.bySlug)}; ${list(s.byFamily)}`;
}

/** Paid x402 calls per source over the window, for the `datasets 30d external` reading. */
export function x402CallsBySlug(rows: X402PaidRow[] | null): Map<string, number> {
  return new Map(rows ? x402Sales(rows).bySlug.filter(([slug]) => !slug.startsWith('(')) : []);
}
