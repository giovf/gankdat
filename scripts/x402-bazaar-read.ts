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
 * Whether the runner spends half a cent today from the probe wallet (action 026 option B):
 * never without the key; always on a forced dispatch; otherwise only when no probe or owner call
 * (`own probe` on a row) landed in the last 7 days AND either the latest `bazaar:` clause still
 * reads `0 listed` (the catalogue has not indexed us — repeat the onboarding payment) or today is
 * the 1st (a monthly liveness payment keeps `lastCalledAt` fresh). An `n/a` clause (the read
 * failed) or no clause at all (the owner makes the first call) never pays.
 */
export function shouldProbe(input: ProbeInput): ProbeDecision {
  if (!input.hasKey)
    return { pay: false, reason: 'X402_PROBE_KEY is not set (action 026 option B)' };
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
  const withClause = rows.find((r) => /bazaar: /.test(r.text));
  const clause = withClause ? (/bazaar: [^;|]*/.exec(withClause.text)?.[0] ?? '') : '';
  if (input.today.endsWith('-01'))
    return { pay: true, reason: 'monthly liveness payment (1st of the month)' };
  if (!withClause)
    return {
      pay: false,
      reason: 'no bazaar clause on any row yet (the owner makes the first call)',
    };
  if (/bazaar: 0 listed/.test(clause))
    return {
      pay: true,
      reason: `${withClause.date} row reads "${clause}": repeat the indexing payment`,
    };
  return { pay: false, reason: `${withClause.date} row reads "${clause}"` };
}
