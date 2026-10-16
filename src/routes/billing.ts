import { Hono } from 'hono';
import { requireApiKey } from '../auth/middleware';
import { createCheckoutUrl, createPortalUrl } from '../billing/checkout';
import { stripeClient, webhookCryptoProvider } from '../billing/client';
import { packListing } from '../billing/packs';
import {
  captureCreditOrder,
  createCreditOrder,
  findOrder,
  paypalEnabled,
  subjectOfAccount,
} from '../billing/paypal';
import { handleStripeEvent } from '../billing/webhook';
import { publicBaseUrl } from '../lib/constants';
import { failure, success } from '../lib/envelope';
import type { AppEnv } from '../types';

const NOT_CONFIGURED = failure(
  'unavailable',
  'Billing is not configured yet (Stripe keys missing)',
);
const PAYPAL_NOT_CONFIGURED = failure(
  'unavailable',
  'Credit packs are not configured yet (PayPal keys missing)',
);

export const billingRoutes = new Hono<AppEnv>()
  .post('/checkout', requireApiKey(), async (c) => {
    const stripe = stripeClient(c.env);
    if (!stripe) return c.json(NOT_CONFIGURED, 503);

    const body = (await c.req.json().catch(() => ({}))) as { plan?: unknown };
    const plan = typeof body.plan === 'string' ? body.plan : '';
    const keyCtx = c.get('keyCtx')!;
    const result = await createCheckoutUrl(stripe, {
      accountId: keyCtx.accountId,
      email: keyCtx.usageSubject,
      plan,
      baseUrl: publicBaseUrl(c.env),
    });
    if (!result.ok) return c.json(failure(result.code, result.message), result.status);
    return c.json(success({ url: result.url, plan }));
  })
  .get('/portal', requireApiKey(), async (c) => {
    const stripe = stripeClient(c.env);
    if (!stripe) return c.json(NOT_CONFIGURED, 503);

    const keyCtx = c.get('keyCtx')!;
    const result = await createPortalUrl(stripe, c.env, keyCtx.accountId);
    if (!result.ok) return c.json(failure(result.code, result.message), result.status);
    return c.json(success({ url: result.url }));
  })
  // Called by Stripe, not users: signature is the auth. Raw body must be read
  // before any parsing or verification fails.
  .post('/webhook', async (c) => {
    const stripe = stripeClient(c.env);
    if (!stripe || !c.env.STRIPE_WEBHOOK_SECRET) return c.json(NOT_CONFIGURED, 503);

    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json(failure('bad_request', 'Missing stripe-signature header'), 400);

    const rawBody = await c.req.text();
    let event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        c.env.STRIPE_WEBHOOK_SECRET,
        undefined,
        webhookCryptoProvider,
      );
    } catch {
      return c.json(failure('bad_request', 'Invalid webhook signature'), 400);
    }

    // Processing errors bubble to a 500 so Stripe retries; the ledger's
    // unique stripe_ref makes those retries safe.
    await handleStripeEvent(c.env, event);
    return c.json(success({ received: true }));
  })
  // --- Credit packs via PayPal (Orders API v2, sandbox only — billing/paypal.ts) ---
  .get('/paypal/packs', (c) =>
    c.json(success({ packs: packListing(), currency: 'USD', sandbox: true })),
  )
  .post('/paypal/orders', requireApiKey(), async (c) => {
    if (!paypalEnabled(c.env)) return c.json(PAYPAL_NOT_CONFIGURED, 503);
    const body = (await c.req.json().catch(() => ({}))) as { pack?: unknown };
    const keyCtx = c.get('keyCtx')!;
    const result = await createCreditOrder(c.env, {
      accountId: keyCtx.accountId,
      pack: typeof body.pack === 'string' ? body.pack : '',
      baseUrl: publicBaseUrl(c.env),
    });
    if (!result.ok) return c.json(failure(result.code, result.message), result.status);
    const { orderId, approveUrl, pack, credits, amountUsd } = result.order;
    return c.json(
      success({
        order_id: orderId,
        approve_url: approveUrl,
        pack,
        credits,
        amount_usd: amountUsd,
        next: `Have the user approve the payment at approve_url; PayPal then returns them to gankdat, which adds the credits. An agent can instead call POST /v1/billing/paypal/orders/${orderId}/capture once the user says they approved.`,
      }),
    );
  })
  .post('/paypal/orders/:id/capture', requireApiKey(), async (c) => {
    if (!paypalEnabled(c.env)) return c.json(PAYPAL_NOT_CONFIGURED, 503);
    const keyCtx = c.get('keyCtx')!;
    const order = await findOrder(c.env, c.req.param('id'));
    // Scoped to the caller's account: another account's order id is a 404, not a hint.
    if (!order || order.account_id !== keyCtx.accountId) {
      return c.json(failure('not_found', 'No such order on this account'), 404);
    }
    const result = await captureCreditOrder(c.env, order, keyCtx.usageSubject);
    if (!result.ok) return c.json(failure(result.code, result.message), result.status);
    return c.json(
      success({
        order_id: order.order_id,
        status: result.status,
        credits_added: result.status === 'completed' ? result.credits : 0,
        topup: result.topup,
      }),
    );
  })
  // The buyer's browser, back from PayPal (?token=<order id>&PayerID=…): capture,
  // then land on the account page with a one-word verdict. No key: the order id
  // is ours and only ever credits the account that created it.
  .get('/paypal/return', async (c) => {
    const back = (verdict: string): Response =>
      c.redirect(`${publicBaseUrl(c.env)}/account?paypal=${verdict}`, 302);
    const orderId = c.req.query('token') ?? '';
    if (!paypalEnabled(c.env) || !orderId) return back('error');
    const order = await findOrder(c.env, orderId);
    if (!order) return back('error');
    const subject = await subjectOfAccount(c.env, order.account_id);
    if (!subject) return back('error');
    const result = await captureCreditOrder(c.env, order, subject);
    if (result.ok) return back('success');
    return back(result.code === 'payment_required' ? 'cancelled' : 'error');
  })
  .get('/paypal/cancel', (c) =>
    c.redirect(`${publicBaseUrl(c.env)}/account?paypal=cancelled`, 302),
  );
