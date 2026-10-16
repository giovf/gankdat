import { CREDIT_PACKS, isCreditPack } from './packs';
import { addTopup, getTopup } from '../metering/topup';

// PayPal Orders API v2, SANDBOX ONLY (PayPal AI Hackathon entry, 2026-10-11):
// a one-off credit pack is an order the buyer approves on PayPal's page and we
// capture on return. Dark until PAYPAL_SANDBOX_CLIENT_ID + PAYPAL_SANDBOX_SECRET
// are set (same pattern as Stripe/x402). The base URL is the sandbox host by
// construction — no live PayPal money moves through this code; switching to
// live is a strategy decision (docs/PAYPAL-SETUP.md), not a config flag.
//
// Flow: POST /v1/billing/paypal/orders (or the buy_credits MCP tool) → order
// row 'created' + approve URL → buyer approves → PayPal redirects to
// /v1/billing/paypal/return?token=<order id> (or the agent calls
// confirm_credit_purchase) → capture → credits added to the top-up balance,
// ledger row written, order row 'completed'. The UPDATE on the order row is the
// idempotency guard, so a replayed capture never grants twice.

export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';
const TOKEN_CACHE_KEY = 'paypal:sandbox:token';

export function paypalEnabled(env: CloudflareBindings): boolean {
  return Boolean(env.PAYPAL_SANDBOX_CLIENT_ID && env.PAYPAL_SANDBOX_SECRET);
}

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue: string | null = null,
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/** Client-credentials token, cached in KV for its lifetime minus a minute. */
async function accessToken(env: CloudflareBindings): Promise<string> {
  const cached = await env.CACHE.get(TOKEN_CACHE_KEY);
  if (cached) return cached;
  const basic = btoa(`${env.PAYPAL_SANDBOX_CLIENT_ID}:${env.PAYPAL_SANDBOX_SECRET}`);
  const res = await fetch(`${PAYPAL_SANDBOX_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new PayPalError(`PayPal token request failed (${res.status})`, res.status);
  const body = (await res.json()) as TokenResponse;
  const ttl = Math.max(60, Math.floor(body.expires_in) - 60);
  await env.CACHE.put(TOKEN_CACHE_KEY, body.access_token, { expirationTtl: ttl });
  return body.access_token;
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  details?: { issue?: string; description?: string }[];
}

async function paypalCall<T>(
  env: CloudflareBindings,
  path: string,
  body: Record<string, unknown> | null,
): Promise<T> {
  const token = await accessToken(env);
  const res = await fetch(`${PAYPAL_SANDBOX_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Idempotency key: PayPal returns the same order for a retried create.
      'PayPal-Request-Id': crypto.randomUUID(),
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as PayPalErrorBody;
    const issue = err.details?.[0]?.issue ?? err.name ?? null;
    throw new PayPalError(
      err.details?.[0]?.description ?? err.message ?? `PayPal call failed (${res.status})`,
      res.status,
      issue,
    );
  }
  return (await res.json()) as T;
}

interface CreatedOrder {
  id: string;
  status: string;
  links?: { href: string; rel: string }[];
}

export interface PayPalOrder {
  orderId: string;
  approveUrl: string;
  pack: string;
  credits: number;
  amountUsd: string;
}

export type CreateOrderResult =
  | { ok: true; order: PayPalOrder }
  | { ok: false; code: 'bad_request' | 'unavailable'; message: string; status: 400 | 503 };

/** Creates the order on PayPal and the 'created' row; the buyer approves at approveUrl. */
export async function createCreditOrder(
  env: CloudflareBindings,
  opts: { accountId: string; pack: string; baseUrl: string },
): Promise<CreateOrderResult> {
  const { accountId, pack, baseUrl } = opts;
  if (!isCreditPack(pack)) {
    return {
      ok: false,
      code: 'bad_request',
      message: `Unknown pack; choose one of: ${Object.keys(CREDIT_PACKS).join(', ')}`,
      status: 400,
    };
  }
  const { credits, usd } = CREDIT_PACKS[pack]!;
  let created: CreatedOrder;
  try {
    created = await paypalCall<CreatedOrder>(env, '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: pack,
          custom_id: accountId,
          description: `gankdat API credits: ${credits.toLocaleString('en-GB')} (${pack})`,
          amount: { currency_code: 'USD', value: usd },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'gankdat',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${baseUrl}/v1/billing/paypal/return`,
            cancel_url: `${baseUrl}/v1/billing/paypal/cancel`,
          },
        },
      },
    });
  } catch (err) {
    log('paypal_order_failed', { accountId, pack, error: String(err) });
    return {
      ok: false,
      code: 'unavailable',
      message: 'PayPal did not accept the order; retry later',
      status: 503,
    };
  }
  // With payment_source the approval link is rel "payer-action"; the legacy
  // application_context shape names it "approve". Accept both.
  const approve = created.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!approve) {
    log('paypal_order_no_link', { accountId, pack, orderId: created.id });
    return {
      ok: false,
      code: 'unavailable',
      message: 'PayPal returned no approval link',
      status: 503,
    };
  }
  await env.DB.prepare(
    'INSERT INTO paypal_orders (order_id, account_id, pack, credits, amount_usd) VALUES (?1, ?2, ?3, ?4, ?5)',
  )
    .bind(created.id, accountId, pack, credits, usd)
    .run();
  log('paypal_order_created', { accountId, pack, orderId: created.id, usd });
  return {
    ok: true,
    order: { orderId: created.id, approveUrl: approve.href, pack, credits, amountUsd: usd },
  };
}

interface CapturedOrder {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[];
}

export interface OrderRow {
  order_id: string;
  account_id: string;
  pack: string;
  credits: number;
  amount_usd: string;
  status: string;
  capture_id: string | null;
}

export async function findOrder(
  env: CloudflareBindings,
  orderId: string,
): Promise<OrderRow | null> {
  return env.DB.prepare(
    'SELECT order_id, account_id, pack, credits, amount_usd, status, capture_id FROM paypal_orders WHERE order_id = ?1',
  )
    .bind(orderId)
    .first<OrderRow>();
}

export type CaptureResult =
  | { ok: true; status: 'completed' | 'already_completed'; credits: number; topup: number }
  | {
      ok: false;
      code: 'not_found' | 'payment_required' | 'unavailable';
      message: string;
      status: 404 | 409 | 503;
    };

/**
 * Captures an approved order and grants its credits exactly once. `subject`
 * is the account's usage subject (normalized email) the top-up is keyed by.
 */
export async function captureCreditOrder(
  env: CloudflareBindings,
  order: OrderRow,
  subject: string,
): Promise<CaptureResult> {
  if (order.status === 'completed') {
    return {
      ok: true,
      status: 'already_completed',
      credits: order.credits,
      topup: await getTopup(env, subject),
    };
  }
  let captured: CapturedOrder;
  try {
    captured = await paypalCall<CapturedOrder>(
      env,
      `/v2/checkout/orders/${encodeURIComponent(order.order_id)}/capture`,
      null,
    );
  } catch (err) {
    if (err instanceof PayPalError && err.issue === 'ORDER_NOT_APPROVED') {
      return {
        ok: false,
        code: 'payment_required',
        message: 'The buyer has not approved this order on PayPal yet',
        status: 409,
      };
    }
    if (err instanceof PayPalError && err.issue === 'ORDER_ALREADY_CAPTURED') {
      // Captured on PayPal's side but our row never flipped (a cut-off between
      // the two writes): fall through and grant on the row's guard below.
      captured = { id: order.order_id, status: 'COMPLETED' };
    } else {
      log('paypal_capture_failed', { orderId: order.order_id, error: String(err) });
      return {
        ok: false,
        code: 'unavailable',
        message: 'PayPal could not capture the order; retry shortly',
        status: 503,
      };
    }
  }
  if (captured.status !== 'COMPLETED') {
    return {
      ok: false,
      code: 'payment_required',
      message: `Order is ${captured.status}, not completed`,
      status: 409,
    };
  }
  const captureId = captured.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? captured.id;
  const flipped = await env.DB.prepare(
    "UPDATE paypal_orders SET status = 'completed', capture_id = ?2, captured_at = datetime('now') WHERE order_id = ?1 AND status = 'created'",
  )
    .bind(order.order_id, captureId)
    .run();
  if (!flipped.meta.changes) {
    log('paypal_capture_replayed', { orderId: order.order_id });
    return {
      ok: true,
      status: 'already_completed',
      credits: order.credits,
      topup: await getTopup(env, subject),
    };
  }
  await env.DB.prepare('INSERT INTO credit_ledger (account_id, delta, reason) VALUES (?1, ?2, ?3)')
    .bind(order.account_id, order.credits, `paypal:${order.pack}`)
    .run();
  const topup = await addTopup(env, subject, order.credits);
  log('paypal_credits_granted', {
    accountId: order.account_id,
    orderId: order.order_id,
    captureId,
    credits: order.credits,
    usd: order.amount_usd,
  });
  return { ok: true, status: 'completed', credits: order.credits, topup };
}

/** The usage subject (normalized email) of an account — what the top-up balance is keyed by. */
export async function subjectOfAccount(
  env: CloudflareBindings,
  accountId: string,
): Promise<string | null> {
  const row = await env.DB.prepare('SELECT email FROM accounts WHERE id = ?1')
    .bind(accountId)
    .first<{ email: string }>();
  return row?.email ?? null;
}
