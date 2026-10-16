import { planAllowance } from '../billing/plans';

// Single source of truth for quota math + upgrade-nudge thresholds, shared by
// the metering middleware, GET /v1/usage, and the MCP get_usage tool so they
// never disagree. Quota = the plan's monthly allowance; usage resets monthly.
export const USAGE_ALERT_THRESHOLDS = { warn: 0.8 } as const;

// ASCII only: non-ASCII header values make browser fetch implementations throw.
export const NUDGE_MESSAGES: Record<'80' | '100', string> = {
  '80': 'Approaching your monthly quota - consider upgrading',
  '100': 'Monthly quota exhausted - upgrade to keep access',
};

export function alertThreshold(used: number, granted: number): '80' | '100' | undefined {
  if (granted <= 0 || used >= granted) return '100';
  if (used >= granted * USAGE_ALERT_THRESHOLDS.warn) return '80';
  return undefined;
}

export interface UsageSummary {
  plan: string;
  granted: number;
  used: number;
  /** Plan credits left this month plus the top-up balance (credit packs). */
  remaining: number;
  /** Bought credits waiting behind the plan allowance; never reset (metering/topup.ts). */
  topup: number;
  alert?: '80' | '100';
  alerts: string[];
}

export function usageSummary(plan: string, used: number, topup = 0): UsageSummary {
  const granted = planAllowance(plan);
  // A buyer holding top-up credits is not nudged to upgrade: they already paid.
  const alert = topup > 0 ? undefined : alertThreshold(used, granted);
  return {
    plan,
    granted,
    used,
    remaining: Math.max(0, granted - used) + topup,
    topup,
    alert,
    alerts: alert ? [alert] : [],
  };
}
