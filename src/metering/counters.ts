// Monthly usage counters in KV (CACHE), keyed usage:<subject>:<yyyymm> where
// subject is the account identity (normalized email), NOT the key id — so all
// keys for one email share a quota and re-issuing keys can't reset it.
//
// Best-effort by design (PRD): KV is eventually consistent and the
// read-modify-write below can lose increments under concurrency, slightly
// over-serving. The accurate upgrade path is a Durable Object per subject
// (single-writer counter) — documented here and in the runbook, deliberately
// NOT built for v1.

const COUNTER_TTL_SECONDS = 62 * 24 * 3600; // two billing periods, then self-cleans

export function currentPeriod(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const usageKey = (subject: string, period: string): string => `usage:${subject}:${period}`;

export async function getUsage(
  env: CloudflareBindings,
  subject: string,
  period: string,
): Promise<number> {
  return Number((await env.CACHE.get(usageKey(subject, period))) ?? '0');
}

/** Returns the new period total. */
export async function incrementUsage(
  env: CloudflareBindings,
  subject: string,
  cost: number,
  period: string,
): Promise<number> {
  const next = (await getUsage(env, subject, period)) + cost;
  await env.CACHE.put(usageKey(subject, period), String(next), {
    expirationTtl: COUNTER_TTL_SECONDS,
  });
  return next;
}
