import { PAID_PLANS } from '../billing/plans';
import { API_BASE_URL, FREE_TIER_CREDITS, X402_DEFAULT_PRICE_USD } from '../lib/constants';

// Keyless preview (build routine 2026-09-30, Claude Connectors Directory).
// An authless directory listing cannot carry an API key, and the directory's
// review requires every tool to answer successfully with valid parameters —
// so a caller with no key gets a small, capped taste of each data tool instead
// of a 401: PREVIEW_ROWS rows per call, PREVIEW_CALLS_PER_DAY calls per client
// per UTC day, then a tool error that names the free plan and the paid ones.
// The client is the caller's IP + User-Agent (hashed; no raw IP lands in KV
// as a value or in analytics) — the best identity an authless request has.
// Claude's shared egress means claude.ai users pool one budget; that is no
// worse than today's 401 and the paywall text now says what to do next.

export const PREVIEW_ROWS = 5;
export const PREVIEW_CALLS_PER_DAY = 20;

export interface PreviewContext {
  /** Opaque per-client id (sha-256 of ip|ua, 16 hex chars). */
  clientId: string;
  userAgent: string;
}

const previewKey = (clientId: string, day: string): string => `preview:${clientId}:${day}`;
const utcDay = (): string => new Date().toISOString().slice(0, 10);

export async function previewClientId(ip: string, userAgent: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${ip}|${userAgent}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function readCount(env: CloudflareBindings, clientId: string): Promise<number> {
  try {
    return Number((await env.RATE.get(previewKey(clientId, utcDay()))) ?? '0');
  } catch {
    return 0; // KV unavailable → fail open, like every other limiter here
  }
}

/** Calls left today for a client, without consuming one (get_usage). */
export async function previewCallsRemaining(
  env: CloudflareBindings,
  clientId: string,
): Promise<number> {
  return Math.max(0, PREVIEW_CALLS_PER_DAY - (await readCount(env, clientId)));
}

/**
 * Consume one preview call. `allowed` false means the day's budget is spent;
 * `remaining` is what is left after this call.
 */
export async function takePreviewCall(
  env: CloudflareBindings,
  clientId: string,
): Promise<{ allowed: boolean; remaining: number }> {
  const used = await readCount(env, clientId);
  if (used >= PREVIEW_CALLS_PER_DAY) return { allowed: false, remaining: 0 };
  try {
    await env.RATE.put(previewKey(clientId, utcDay()), String(used + 1), {
      expirationTtl: 2 * 86_400,
    });
  } catch {
    // count lost, call allowed — acceptable degradation
  }
  return { allowed: true, remaining: PREVIEW_CALLS_PER_DAY - used - 1 };
}

/** Clamp a query's page size to the preview window (page 1 only). */
export function clampPreviewArgs(args: Record<string, unknown>): Record<string, unknown> {
  const asked = Number(args.per_page ?? PREVIEW_ROWS);
  return {
    ...args,
    page: 1,
    per_page: Number.isFinite(asked) && asked >= 1 ? Math.min(asked, PREVIEW_ROWS) : PREVIEW_ROWS,
  };
}

function cheapestPaid(): { name: string; gbp: number; credits: number } | null {
  const plans = Object.values(PAID_PLANS).sort((a, b) => a.gbpPerMonth - b.gbpPerMonth);
  const first = plans[0];
  return first ? { name: first.displayName, gbp: first.gbpPerMonth, credits: first.credits } : null;
}

/**
 * What a keyless caller is told, both alongside preview rows and once the budget is spent.
 * Every way to continue, in the order an agent can act on them (gankdat preview-wall-next-steps,
 * 2026-10-11: the first client to hit the wall — 47 challenges in a day, bid-intelligence tools —
 * was told only to sign in, which an autonomous agent cannot do, and the two agent paths that
 * already existed went unnamed): pay per call with no account at all, a free key by email
 * through the agent, or a person's sign-in.
 */
export function previewNextStep(): string {
  const paid = cheapestPaid();
  const paidLine = paid
    ? ` Paid plans from £${paid.gbp}/month (${paid.name}: ${paid.credits.toLocaleString('en-GB')} credits) at ${API_BASE_URL}/#pricing.`
    : '';
  return `Three ways to continue: (1) no account, pay per call — GET ${API_BASE_URL}/x402/data/<source> with an x402 payment (USDC on Base, from ${X402_DEFAULT_PRICE_USD} a call; the 402 body states the exact terms); (2) a free API key through this chat — call request_api_key with the user's email, then claim_api_key: ${FREE_TIER_CREDITS} credits/month, full pages, no card; (3) a person — in Claude call connect_account to sign in, or sign in at ${API_BASE_URL}/account. Send a key as "Authorization: Bearer <key>".${paidLine}`;
}

export function previewExhaustedMessage(): string {
  return `Preview limit reached: ${PREVIEW_CALLS_PER_DAY} keyless calls per day (${PREVIEW_ROWS} rows each). ${previewNextStep()}`;
}
