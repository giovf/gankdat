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
//
// Buyers vs probers (gankdat `x402-buyer-vs-survey-split`, 2026-10-25): the 10-25 row read
// `x402 30d: 19 paid, 4 clients`, but 15 of the 19 were `lumiere-paycheck-prober` paying each
// unpaid route once on 10-24/25 — a catalogue survey, not demand — and the day-30 reads and two
// parked exchange triggers quote this clause as demand. So every paid row is classed: a client
// whose user agent names itself a probe (`PROBER_UA`), or that on one day paid `routes` distinct
// sources once each (the indexer's own call per route), is a prober; everyone else is a buyer,
// and a buyer that paid on two or more days is a repeat payer. The slug and UA breakdowns, the
// `datasets 30d external` map and the exchange triggers read buyers only.

export interface X402PaidRow {
  slug: string | null;
  ua: string | null;
  /** Hashed client id (blob6); '' when the point predates it. */
  client: string | null;
  /**
   * UTC day the payments landed (`toStartOfInterval(timestamp, INTERVAL '1' DAY)`); absent or
   * '' when the window is a single day (the 24-h read).
   */
  day?: string | null;
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

export interface X402PayerSplit {
  /** Clients that look like customers: paid calls, distinct clients, clients paying on ≥ 2 days. */
  buyers: X402SalesSummary & { repeat: number };
  /** Catalogue probers: paid calls, distinct clients and their UA families. */
  probers: X402SalesSummary;
}

/** A user agent that names itself a survey of the catalogue rather than a customer. */
export const PROBER_UA = /probe|prober|scout|observatory|survey|collector/i;

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

/** True for a user agent that calls itself a probe, prober, scout, observatory, survey or collector. */
export function isProberUa(ua: string | null): boolean {
  return PROBER_UA.test(ua ?? '');
}

const tally = (rows: X402PaidRow[], key: (r: X402PaidRow) => string): [string, number][] => {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    counts.set(k, (counts.get(k) ?? 0) + whole(r.n));
  }
  return [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};

/** Sums the grouped rows of one window (slug × UA × client [× day]). */
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

/**
 * A client's rows sweep the catalogue on one day when they pay at least `routes` distinct
 * sources and no source more than once — the Bazaar indexer's call per route. `routes` null
 * (the live listing unread) or under 2 disables the rule; the UA rule still applies.
 */
function sweepsCatalogue(rows: X402PaidRow[], routes: number | null): boolean {
  if (routes === null || routes < 2) return false;
  const byDay = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const n = whole(r.n);
    if (n === 0) continue;
    const day = r.day ?? '';
    const slugs = byDay.get(day) ?? new Map<string, number>();
    const slug = r.slug || '(no source)';
    slugs.set(slug, (slugs.get(slug) ?? 0) + n);
    byDay.set(day, slugs);
  }
  for (const slugs of byDay.values()) {
    if (slugs.size >= routes && [...slugs.values()].every((n) => n === 1)) return true;
  }
  return false;
}

/**
 * Classes every row as a buyer's or a prober's. Rows with no client id (points before blob6)
 * are judged by their user agent alone and never count as a client. `routes` is the number of
 * live x402 routes (the sweep rule's threshold), null when unknown.
 */
export function splitX402Payers(rows: X402PaidRow[], routes: number | null = null): X402PayerSplit {
  const byClient = new Map<string, X402PaidRow[]>();
  const buyerRows: X402PaidRow[] = [];
  const proberRows: X402PaidRow[] = [];
  for (const r of rows) {
    if (!r.client) (isProberUa(r.ua) ? proberRows : buyerRows).push(r);
    else byClient.set(r.client, [...(byClient.get(r.client) ?? []), r]);
  }
  let repeat = 0;
  for (const clientRows of byClient.values()) {
    const prober = clientRows.some((r) => isProberUa(r.ua)) || sweepsCatalogue(clientRows, routes);
    if (prober) {
      proberRows.push(...clientRows);
      continue;
    }
    buyerRows.push(...clientRows);
    const days = new Set(clientRows.filter((r) => whole(r.n) > 0).map((r) => r.day ?? ''));
    if (days.size >= 2) repeat += 1;
  }
  return { buyers: { ...x402Sales(buyerRows), repeat }, probers: x402Sales(proberRows) };
}

const list = (pairs: [string, number][]): string => pairs.map(([k, n]) => `${k} ${n}`).join(', ');
const clientsText = (n: number): string => `${n} client${n === 1 ? '' : 's'}`;

/**
 * The row's sales cell: `3 x402 paid (uk-sanctions 2, eu-ted 1; 3 clients; python-requests 2,
 * x402-fetch 1)`; `0 x402 paid` unchanged when nothing sold. `total` is the row's own 24-h count
 * (the `kinds` query); the breakdown is rendered only when the grouped rows agree with it, so a
 * failed or partial grouped read never misstates a sale. A prober's payments are set apart —
 * `15 x402 paid (0 by buyers; probers 15: lumiere-paycheck-prober 15)` — so a survey never reads
 * as a sale; the slug and UA breakdown is the buyers'.
 */
export function x402PaidClause(
  total: number | string,
  rows: X402PaidRow[] | null,
  routes: number | null = null,
): string {
  const n = whole(total);
  const head = `${n} x402 paid`;
  if (n === 0 || !rows) return head;
  const { buyers, probers } = splitX402Payers(rows, routes);
  if (buyers.paid + probers.paid !== n) return head;
  const bought = buyers.paid
    ? `${list(buyers.bySlug)}; ${clientsText(buyers.clients)}; ${list(buyers.byFamily)}`
    : '';
  if (probers.paid === 0) return `${head} (${bought})`;
  const probed = `probers ${probers.paid}: ${list(probers.byFamily)}`;
  return `${head} (${buyers.paid ? `${buyers.paid} by buyers: ${bought}` : '0 by buyers'}; ${probed})`;
}

/**
 * The 30-day note: `x402 30d: 19 paid, 4 clients — buyers 4 paid, 3 clients, repeat 1
 * (uk-sanctions 3, eu-ted 1; python-requests 3, x402-fetch 1); probers 15 paid, 1 client
 * (lumiere-paycheck-prober 15)`; `probers 0` when every payer looks like a buyer.
 */
export function x402Paid30dNote(rows: X402PaidRow[] | null, routes: number | null = null): string {
  if (!rows) return 'x402 30d: n/a';
  const all = x402Sales(rows);
  if (all.paid === 0) return 'x402 30d: 0 paid';
  const { buyers, probers } = splitX402Payers(rows, routes);
  const buyerText = buyers.paid
    ? `buyers ${buyers.paid} paid, ${clientsText(buyers.clients)}, repeat ${buyers.repeat} (${list(buyers.bySlug)}; ${list(buyers.byFamily)})`
    : 'buyers 0';
  const proberText = probers.paid
    ? `probers ${probers.paid} paid, ${clientsText(probers.clients)} (${list(probers.byFamily)})`
    : 'probers 0';
  return `x402 30d: ${all.paid} paid, ${clientsText(all.clients)} — ${buyerText}; ${proberText}`;
}

/**
 * Paid x402 calls per source over the window, for the `datasets 30d external` reading — buyers
 * only, so a catalogue sweep never starts §7's demand clock or an exchange trigger.
 */
export function x402CallsBySlug(
  rows: X402PaidRow[] | null,
  routes: number | null = null,
): Map<string, number> {
  if (!rows) return new Map();
  return new Map(
    splitX402Payers(rows, routes).buyers.bySlug.filter(([slug]) => !slug.startsWith('(')),
  );
}
