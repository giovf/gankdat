import { planAllowance } from '../billing/plans';
import { API_BASE_URL, DOCS_ERRORS_URL } from '../lib/constants';
import { currentPeriod, getUsage, incrementUsage } from './counters';
import { getTopup, spendTopup } from './topup';
import type { KeyContext } from '../types';

// One budget decision for REST metering and the MCP data tools so they never
// disagree: a call is paid from the month's plan allowance first and, once that
// is spent, from the top-up balance bought as credit packs (PayPal). The top-up
// is read only when the allowance is exhausted, so the common path costs the
// same one KV read as before.

export type BudgetCheck =
  | { ok: true; source: 'plan'; granted: number; used: number; cost: number }
  | { ok: true; source: 'topup'; granted: number; cost: number }
  | { ok: false; granted: number };

export async function checkBudget(
  env: CloudflareBindings,
  keyCtx: KeyContext,
  cost: number,
): Promise<BudgetCheck> {
  const granted = planAllowance(keyCtx.plan);
  const used = await getUsage(env, keyCtx.usageSubject, currentPeriod());
  if (used + cost <= granted) return { ok: true, source: 'plan', granted, used, cost };
  const topup = await getTopup(env, keyCtx.usageSubject);
  if (topup >= cost) return { ok: true, source: 'topup', granted, cost };
  return { ok: false, granted };
}

/** Debits the budget a successful call was admitted on; returns what is left on that budget. */
export async function chargeBudget(
  env: CloudflareBindings,
  keyCtx: KeyContext,
  check: Extract<BudgetCheck, { ok: true }>,
): Promise<{ remaining: number; source: 'plan' | 'topup'; used: number }> {
  if (check.source === 'plan') {
    const used = await incrementUsage(env, keyCtx.usageSubject, check.cost, currentPeriod());
    return { remaining: Math.max(0, check.granted - used), source: 'plan', used };
  }
  const remaining = await spendTopup(env, keyCtx.usageSubject, check.cost);
  return { remaining, source: 'topup', used: check.granted };
}

export function exhaustedMessage(granted: number): string {
  return `Monthly credit quota exhausted (${granted}) and no top-up credits left; buy a credit pack (POST ${API_BASE_URL}/v1/billing/paypal/orders or the buy_credits tool) or upgrade via POST ${API_BASE_URL}/v1/billing/checkout — see ${DOCS_ERRORS_URL}#quota_exceeded`;
}
