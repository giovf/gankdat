// Top-up credits in KV (CACHE), keyed topup:<subject> — the same subject as the
// monthly usage counter (normalized email), so every key under an account shares
// the balance. Unlike usage:<subject>:<yyyymm> it has no period and no TTL:
// bought credits wait until the plan allowance is spent, then drain one call at
// a time (metering/budget.ts). Best-effort like counters.ts (KV is eventually
// consistent; a lost decrement over-serves slightly). The durable audit trail is
// credit_ledger (reason paypal:<pack>) and paypal_orders in D1 — never the quota.

const topupKey = (subject: string): string => `topup:${subject}`;

export async function getTopup(env: CloudflareBindings, subject: string): Promise<number> {
  return Number((await env.CACHE.get(topupKey(subject))) ?? '0');
}

/** Adds credits; returns the new balance. */
export async function addTopup(
  env: CloudflareBindings,
  subject: string,
  credits: number,
): Promise<number> {
  const next = (await getTopup(env, subject)) + credits;
  await env.CACHE.put(topupKey(subject), String(next));
  return next;
}

/** Spends credits (floored at zero); returns the new balance. */
export async function spendTopup(
  env: CloudflareBindings,
  subject: string,
  cost: number,
): Promise<number> {
  const next = Math.max(0, (await getTopup(env, subject)) - cost);
  await env.CACHE.put(topupKey(subject), String(next));
  return next;
}
