// The x402 Bazaar catalogue as the runner reads it (gankdat `x402-bazaar-week-1-index-check`,
// 2026-10-23): one place for the three keyless reads `scripts/metrics.mjs` (the `bazaar:` clause)
// and `scripts/x402-probe.mjs` (which routes to pay) share. Plain Node, builtins only; the pure
// parsing stays in ./x402-bazaar-read.ts.
import { merchantResources, payToFromPaymentRequired } from './x402-bazaar-read.ts';

export const CDP = 'https://api.cdp.coinbase.com/platform/v2/x402';

/** The live x402 route slugs — the public listing, keyless. */
export async function readLiveSlugs(base) {
  const listing = await fetch(`${base}/v1/data`, { signal: AbortSignal.timeout(15_000) });
  if (!listing.ok) throw new Error(`/v1/data ${listing.status}`);
  return (await listing.json()).data.map((s) => s.slug);
}

/**
 * The receiving wallet from a route's 402 (`PAYMENT-REQUIRED`, keyless, no payment): the Worker
 * secret is never read by a runner, the live route says it.
 */
export async function readPayTo(base, slug, userAgent) {
  const unpaid = await fetch(`${base}/x402/data/${slug}?per_page=1`, {
    headers: { 'User-Agent': userAgent },
    signal: AbortSignal.timeout(15_000),
  });
  const payTo = payToFromPaymentRequired(
    unpaid.headers.get('payment-required'),
    await unpaid.json().catch(() => null),
  );
  if (!payTo) throw new Error(`no payTo in the ${unpaid.status} from /x402/data/${slug}`);
  return payTo;
}

/** Every active resource the catalogue holds for `payTo` (paged, at most 500). */
export async function readMerchantCatalogue(payTo) {
  const resources = [];
  for (let offset = 0, page = 0; page < 5; page++, offset += 100) {
    const url = `${CDP}/discovery/merchant?payTo=${payTo}&limit=100&offset=${offset}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`merchant HTTP ${res.status}`);
    const body = await res.json();
    const items = merchantResources(body);
    resources.push(...items);
    const total = Number(body?.pagination?.total ?? 0);
    if (items.length < 100 || resources.length >= total) break;
  }
  return resources;
}
