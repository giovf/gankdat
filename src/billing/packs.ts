// One-off credit packs sold through PayPal (billing/paypal.ts) — data, never
// logic, like plans.json. A pack adds to the account's top-up balance
// (metering/topup.ts), which is spent only once the month's plan allowance is
// gone and never resets, so a pack is a buffer on top of any plan, free included.
import packsData from './packs.json';

export interface CreditPack {
  /** Credits added to the top-up balance when the order is captured. */
  credits: number;
  /** Price as PayPal wants it: a decimal string, two places, USD. */
  usd: string;
}

export const CREDIT_PACKS: Record<string, CreditPack> = packsData;

export function isCreditPack(pack: string): boolean {
  return Object.hasOwn(CREDIT_PACKS, pack);
}

export function packListing(): { pack: string; credits: number; usd: string }[] {
  return Object.entries(CREDIT_PACKS).map(([pack, p]) => ({
    pack,
    credits: p.credits,
    usd: p.usd,
  }));
}
