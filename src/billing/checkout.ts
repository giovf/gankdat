import type Stripe from 'stripe';
import { isPaidPlan, PAID_PLANS } from './plans';
import { publicBaseUrl } from '../lib/constants';

// Shared Stripe checkout/portal logic so the API-key path (/v1/billing/*) and the
// session path (/v1/account/*) create identical, account-keyed sessions — no
// drift between the two entry points.

export type BillingUrl =
  | { ok: true; url: string }
  | {
      ok: false;
      code: 'bad_request' | 'unavailable' | 'not_found';
      message: string;
      status: 400 | 404 | 503;
    };

export async function createCheckoutUrl(
  stripe: Stripe,
  opts: { accountId: string; email: string; plan: string; baseUrl: string; returnPath?: string },
): Promise<BillingUrl> {
  const { accountId, email, plan, baseUrl, returnPath = '/' } = opts;
  if (!isPaidPlan(plan)) {
    return {
      ok: false,
      code: 'bad_request',
      message: `Unknown plan; choose one of: ${Object.keys(PAID_PLANS).join(', ')}`,
      status: 400,
    };
  }
  const prices = await stripe.prices.list({ lookup_keys: [PAID_PLANS[plan]!.lookupKey], limit: 1 });
  const price = prices.data[0];
  if (!price) {
    return {
      ok: false,
      code: 'unavailable',
      message: 'Plan price missing in Stripe — run scripts/stripe-setup.mjs',
      status: 503,
    };
  }
  const metadata = { accountId, plan };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: accountId,
    // Reuse one Stripe customer per email so re-subscribing doesn't duplicate it.
    customer_email: email,
    metadata,
    subscription_data: { metadata },
    success_url: `${baseUrl}${returnPath}?checkout=success`,
    cancel_url: `${baseUrl}${returnPath}?checkout=cancelled`,
  });
  return { ok: true, url: session.url! };
}

export async function createPortalUrl(
  stripe: Stripe,
  env: CloudflareBindings,
  accountId: string,
  returnPath = '/',
): Promise<BillingUrl> {
  const row = await env.DB.prepare(
    'SELECT stripe_customer_id FROM stripe_customers WHERE account_id = ?1',
  )
    .bind(accountId)
    .first<{ stripe_customer_id: string }>();
  if (!row) {
    return {
      ok: false,
      code: 'not_found',
      message: 'No billing account yet — purchase a plan first',
      status: 404,
    };
  }
  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: `${publicBaseUrl(env)}${returnPath}`,
  });
  return { ok: true, url: portal.url };
}
