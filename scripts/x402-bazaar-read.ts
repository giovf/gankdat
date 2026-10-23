// x402 Bazaar reading for the Daily numbers row (gankdat `metrics-bazaar-merchant-read`,
// 2026-10-14). Pure functions only — no node builtins — so the Workers-pool tests import them and
// `scripts/metrics.mjs` and `scripts/x402-probe.ts` share one reading of CDP's shapes:
//
// - the 402 a v2 route answers carries `PAYMENT-REQUIRED` (base64 JSON, `accepts[].payTo`): the
//   receiving wallet is a Worker secret, so the runner learns it from the live route, keyless;
// - `GET /platform/v2/x402/discovery/merchant?payTo=…` returns every active resource the
//   catalogue holds for that wallet, each with `quality.l30DaysTotalCalls`,
//   `quality.l30DaysUniquePayers` and `quality.lastCalledAt` (the numbers the Bazaar ranks by);
// - the clause reads `bazaar: N listed, C calls/30d, P payers, last <date>` — `bazaar: 0 listed`
//   until the catalogue indexes us (one settled payment, action 026). Payers are summed per
//   resource (payer-slots, the same reading as the exchange's top-200 count).

export interface BazaarQuality {
  l30DaysTotalCalls?: number;
  l30DaysUniquePayers?: number;
  lastCalledAt?: string | null;
}

export interface BazaarResource {
  resource?: string;
  quality?: BazaarQuality | null;
  lastUpdated?: string;
}

export interface BazaarSummary {
  listed: number;
  calls: number;
  payers: number;
  /** ISO date (YYYY-MM-DD) of the latest paid call, or null when none was recorded. */
  last: string | null;
}

interface PaymentRequired {
  accepts?: { payTo?: string }[];
  error?: string;
  extensions?: { bazaar?: { info?: { input?: { queryParams?: unknown } } } };
}

const decodeBase64 = (value: string): string => atob(value);

const firstPayTo = (doc: unknown): string | null => {
  const accepts = (doc as PaymentRequired | null)?.accepts;
  if (!Array.isArray(accepts)) return null;
  for (const entry of accepts) {
    const payTo = entry?.payTo;
    if (typeof payTo === 'string' && /^0x[0-9a-fA-F]{40}$/.test(payTo)) return payTo;
  }
  return null;
};

/**
 * The receiving wallet from a 402: the v2 `PAYMENT-REQUIRED` header first (base64 JSON), then the
 * body's `accepts[]` (a v1-shaped document); null when neither names an EVM address.
 */
export function payToFromPaymentRequired(header: string | null, body: unknown): string | null {
  if (header) {
    try {
      const fromHeader = firstPayTo(JSON.parse(decodeBase64(header.trim())));
      if (fromHeader) return fromHeader;
    } catch {
      // not base64 JSON — fall through to the body
    }
  }
  return firstPayTo(body);
}

/** The 402's own reason (`error` in the PAYMENT-REQUIRED document), or null. */
export function errorFromPaymentRequired(header: string | null): string | null {
  if (!header) return null;
  try {
    const error = (JSON.parse(decodeBase64(header.trim())) as PaymentRequired | null)?.error;
    return typeof error === 'string' && error.trim() ? error.trim() : null;
  } catch {
    return null;
  }
}

export type ExampleQuery = Record<string, string | number | boolean>;

/**
 * The example query the route declares for the Bazaar (`extensions.bazaar.info.input.queryParams`
 * in the 402's PAYMENT-REQUIRED document) — what the catalogue's indexer sends, so a probe call
 * that uses it is the exact call the listing shows (a lookup route needs its key, 2026-10-23:
 * `?per_page=1` on uk-company-profiles answered 400 and settled nothing).
 */
export function exampleQueryFromPaymentRequired(header: string | null): ExampleQuery | null {
  if (!header) return null;
  try {
    const params = (JSON.parse(decodeBase64(header.trim())) as PaymentRequired | null)?.extensions
      ?.bazaar?.info?.input?.queryParams;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    const out: ExampleQuery = {};
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        out[key] = value;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** The route URL with the query — the declared example, else one record. */
export function routeUrl(base: string, slug: string, query: ExampleQuery | null): string {
  const url = new URL(`${base.replace(/\/+$/, '')}/x402/data/${slug}`);
  for (const [key, value] of Object.entries(query ?? { per_page: 1 }))
    url.searchParams.set(key, String(value));
  return url.toString();
}

/** The resource list of a merchant or discovery response, whichever key the API used. */
export function merchantResources(body: unknown): BazaarResource[] {
  const record = body as { resources?: unknown; items?: unknown } | null;
  const list = Array.isArray(record?.resources)
    ? record.resources
    : Array.isArray(record?.items)
      ? record.items
      : [];
  return list.filter((r): r is BazaarResource => !!r && typeof r === 'object');
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Sums the catalogue's 30-day numbers over the resources under `base` (a resource of another
 * seller on the same wallet, or a stale host, never counts).
 */
export function bazaarSummary(resources: BazaarResource[], base: string): BazaarSummary {
  const prefix = base.replace(/\/+$/, '').toLowerCase() + '/';
  const ours = resources.filter(
    (r) => typeof r.resource === 'string' && r.resource.toLowerCase().startsWith(prefix),
  );
  let calls = 0;
  let payers = 0;
  let last: string | null = null;
  for (const r of ours) {
    calls += count(r.quality?.l30DaysTotalCalls);
    payers += count(r.quality?.l30DaysUniquePayers);
    const at = r.quality?.lastCalledAt;
    if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at)) {
      const day = at.slice(0, 10);
      if (!last || day > last) last = day;
    }
  }
  return { listed: ours.length, calls, payers, last };
}

/** The row clause: `bazaar: 17 listed, 3 calls/30d, 2 payers, last 2026-10-20`, or `bazaar: 0 listed`. */
export function bazaarClause(summary: BazaarSummary): string {
  if (summary.listed === 0) return 'bazaar: 0 listed';
  return `bazaar: ${summary.listed} listed, ${summary.calls} calls/30d, ${summary.payers} payers, last ${summary.last ?? 'never'}`;
}

export interface ProbeDecision {
  pay: boolean;
  reason: string;
}

export interface ProbeInput {
  /** Whether the `X402_PROBE_KEY` secret is present (its value is never read here). */
  hasKey: boolean;
  /** `workflow_dispatch` input `x402_probe` — a re-screen after a metadata change. */
  forced: boolean;
  /** Today, YYYY-MM-DD (UTC). */
  today: string;
  /** `ventures/gankdat/RESEARCH.md` as checked out (its Daily numbers rows). */
  research: string;
}

const DAILY_ROW = /^\| (\d{4}-\d{2}-\d{2}) \| Daily numbers \|(.*)$/gm;

/** The Daily numbers rows by date, newest first. */
export function dailyRows(research: string): { date: string; text: string }[] {
  return [...research.matchAll(DAILY_ROW)]
    .map((m) => ({ date: m[1] ?? '', text: m[2] ?? '' }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/**
 * Half-cent probe payments the rows of the last `days` days record (`(+N own probe)` in the sales
 * cell — each payment reaches exactly one row, the next morning's).
 */
export function ownProbePayments(research: string, today: string, days = 30): number {
  let n = 0;
  for (const r of dailyRows(research)) {
    const age = daysBetween(today, r.date);
    if (age < 0 || age > days) continue;
    const m = /\(\+(\d+) own probe\)/.exec(r.text);
    if (m) n += Number(m[1]);
  }
  return n;
}

/**
 * The most half-cent calls the probe wallet pays in any 30 days: every route once (the catalogue
 * drops a resource 30 days after its last settlement, CDP docs 2026-10-23) plus three re-screens
 * — US$0.10 a month at most, whatever the catalogue does.
 */
export const PROBE_MONTHLY_CAP = 20;

/**
 * Whether the runner reads the catalogue and pays what is due today (action 026 option B): never
 * without the key; always on a forced dispatch; otherwise only when no probe or owner call
 * (`own probe` on a row) landed in the last 7 days and the 30-day cap is not spent. Which routes
 * get a payment is `probeTargets` on the live catalogue: the 10-23 reading showed CDP indexes
 * one resource per settled payment (uk-tenders, the only route ever paid, was the only one of 17
 * listed after a week), so `0 listed` and the old monthly liveness call are both covered by it.
 */
export function shouldProbe(input: ProbeInput): ProbeDecision {
  if (!input.hasKey)
    return { pay: false, reason: 'X402_PROBE_KEY is not set (action 026 option B)' };
  const spent = ownProbePayments(input.research, input.today);
  if (input.forced && spent >= PROBE_MONTHLY_CAP)
    return {
      pay: false,
      reason: `forced, but the 30-day cap is spent (${spent} of ${PROBE_MONTHLY_CAP} half-cents)`,
    };
  if (input.forced) return { pay: true, reason: 'forced by the workflow_dispatch input' };
  const rows = dailyRows(input.research);
  const recent = rows.find(
    (r) =>
      daysBetween(input.today, r.date) <= 7 &&
      daysBetween(input.today, r.date) >= 0 &&
      /own probe/.test(r.text),
  );
  if (recent)
    return { pay: false, reason: `a probe payment landed on ${recent.date} (7-day spacing)` };
  if (spent >= PROBE_MONTHLY_CAP)
    return {
      pay: false,
      reason: `30-day cap spent (${spent} of ${PROBE_MONTHLY_CAP} half-cents)`,
    };
  return {
    pay: true,
    reason: `no probe payment in 7 days (${spent} of ${PROBE_MONTHLY_CAP} half-cents in 30 d): reading the catalogue`,
  };
}

export interface ProbeTarget {
  slug: string;
  url: string;
  /** `unlisted`, `stale 25 d`, `never called` or `forced`. */
  reason: string;
}

export interface ProbeTargetsInput {
  /** Live x402 route slugs (`/v1/data`). */
  slugs: string[];
  /** The catalogue's resources under our payTo (`merchantResources`). */
  resources: BazaarResource[];
  base: string;
  today: string;
  forced: boolean;
  /** Days since the last settlement after which a listed route is paid again (default 23). */
  staleDays?: number;
}

/**
 * The routes that need a settled payment today, each with why: every route the catalogue does
 * not list (CDP indexes per resource), and every listed route whose last settlement is `staleDays`
 * old or unknown (a resource leaves the catalogue 30 days after its last settlement; 23 leaves
 * the weekly probe one more chance). A forced run pays every route (a re-screen after a
 * metadata change is per resource too). The URL asks for one record, the cheapest paid call.
 */
export function probeTargets(input: ProbeTargetsInput): ProbeTarget[] {
  const base = input.base.replace(/\/+$/, '');
  const prefix = base.toLowerCase() + '/x402/data/';
  const staleDays = input.staleDays ?? 23;
  const listed = new Map<string, BazaarResource>();
  for (const r of input.resources) {
    const resource = typeof r.resource === 'string' ? r.resource.toLowerCase() : '';
    if (!resource.startsWith(prefix)) continue;
    const slug = resource
      .slice(prefix.length)
      .replace(/[?#].*$/, '')
      .replace(/\/+$/, '');
    if (slug && !listed.has(slug)) listed.set(slug, r);
  }
  const targets: ProbeTarget[] = [];
  for (const slug of input.slugs) {
    const url = `${base}/x402/data/${slug}?per_page=1`;
    if (input.forced) {
      targets.push({ slug, url, reason: 'forced' });
      continue;
    }
    const entry = listed.get(slug.toLowerCase());
    if (!entry) {
      targets.push({ slug, url, reason: 'unlisted' });
      continue;
    }
    const at = entry.quality?.lastCalledAt;
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(at)) {
      targets.push({ slug, url, reason: 'never called' });
      continue;
    }
    const age = daysBetween(input.today, at.slice(0, 10));
    if (age >= staleDays) targets.push({ slug, url, reason: `stale ${age} d` });
  }
  return targets;
}

/**
 * One job-log line per resource of ours the catalogue holds — `bazaar resource:
 * https://gankdat.com/x402/data/uk-sanctions calls 3 payers 3 last 2026-10-18` — so a
 * `bazaar:` clause can be read by resource without a token (2026-10-19,
 * `x402-paid-by-source-reading`). Sorted by calls, most first.
 */
export function bazaarResourceLines(resources: BazaarResource[], base: string): string[] {
  const prefix = base.replace(/\/+$/, '').toLowerCase() + '/';
  return resources
    .filter((r) => typeof r.resource === 'string' && r.resource.toLowerCase().startsWith(prefix))
    .map((r) => ({
      resource: String(r.resource),
      calls: count(r.quality?.l30DaysTotalCalls),
      payers: count(r.quality?.l30DaysUniquePayers),
      last: (() => {
        const at = r.quality?.lastCalledAt;
        return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : 'never';
      })(),
    }))
    .sort((a, b) => b.calls - a.calls || (a.resource < b.resource ? -1 : 1))
    .map(
      (r) => `bazaar resource: ${r.resource} calls ${r.calls} payers ${r.payers} last ${r.last}`,
    );
}
