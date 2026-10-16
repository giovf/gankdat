import type { DataSource } from '../sources/types';

// Pricing is launch-time config (PRD open question #5): quotas and costs stay
// data, never branching logic. Health/usage/openapi endpoints are unmetered by
// construction (the metering middleware is simply not mounted on them).
export const DEFAULT_CREDIT_COST = 1;

export function creditCost(source: DataSource | undefined): number {
  return source?.creditCost ?? DEFAULT_CREDIT_COST;
}
