import type Stripe from 'stripe';
import { PAID_PLANS, planByLookupKey } from './plans';
import { keyCacheKey } from '../auth/middleware';

// Grants happen ONLY on invoice.paid (fires for the first payment and every
// renewal); checkout.session.completed just links customer ↔ account ↔ plan.
// This split avoids double-granting on subscription creation and keeps
// renewals working with zero extra code. Everything keys off the ACCOUNT
// (email identity), so a plan change applies to every key under that email.

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'info', event, ...fields }));
}

// Plan/entitlement is account-level, so a change must invalidate the hot-path
// KV cache entry for EVERY key under the account (bounded set; accounts hold a
// handful of keys).
async function invalidateAccountKeys(env: CloudflareBindings, accountId: string): Promise<void> {
  const { results } = await env.DB.prepare('SELECT key_hash FROM api_keys WHERE account_id = ?1')
    .bind(accountId)
    .all<{ key_hash: string }>();
  await Promise.all(results.map((r) => env.CACHE.delete(keyCacheKey(r.key_hash))));
}

async function customerLink(
  env: CloudflareBindings,
  customerId: string,
): Promise<{ account_id: string; plan: string | null } | null> {
  return env.DB.prepare(
    'SELECT account_id, plan FROM stripe_customers WHERE stripe_customer_id = ?1',
  )
    .bind(customerId)
    .first<{ account_id: string; plan: string | null }>();
}

function customerIdOf(customer: string | { id: string } | null | undefined): string | null {
  if (!customer) return null;
  return typeof customer === 'string' ? customer : customer.id;
}

async function onCheckoutCompleted(env: CloudflareBindings, event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;
  const accountId = session.metadata?.accountId ?? session.client_reference_id;
  const plan = session.metadata?.plan;
  const customerId = customerIdOf(session.customer);
  if (!accountId || !plan || !customerId || !(plan in PAID_PLANS)) {
    log('stripe_event_skipped', { type: event.type, id: event.id, reason: 'missing metadata' });
    return;
  }
  await env.DB.batch([
    // Keep one Stripe customer per account: drop any stale row pointing this
    // account at a different customer id (unique index on account_id).
    env.DB.prepare(
      'DELETE FROM stripe_customers WHERE account_id = ?2 AND stripe_customer_id != ?1',
    ).bind(customerId, accountId),
    env.DB.prepare(
      `INSERT INTO stripe_customers (stripe_customer_id, account_id, plan, status)
       VALUES (?1, ?2, ?3, 'active')
       ON CONFLICT (stripe_customer_id)
       DO UPDATE SET account_id = ?2, plan = ?3, status = 'active', updated_at = datetime('now')`,
    ).bind(customerId, accountId, plan),
    env.DB.prepare(
      "UPDATE accounts SET plan = ?2, updated_at = datetime('now') WHERE id = ?1",
    ).bind(accountId, plan),
  ]);
  await invalidateAccountKeys(env, accountId);
  log('stripe_customer_linked', { accountId, plan, customerId });
}

async function onInvoicePaid(env: CloudflareBindings, event: Stripe.Event): Promise<void> {
  const invoice = event.data.object as Stripe.Invoice;
  const meta = invoice.parent?.subscription_details?.metadata ?? {};
  let accountId: string | undefined = meta.accountId;
  let plan: string | undefined = meta.plan;

  const customerId = customerIdOf(invoice.customer);
  if ((!accountId || !plan) && customerId) {
    const link = await customerLink(env, customerId);
    accountId ??= link?.account_id;
    plan ??= link?.plan ?? undefined;
  }
  if (!accountId || !plan || !(plan in PAID_PLANS)) {
    log('stripe_event_skipped', {
      type: event.type,
      id: event.id,
      reason: 'unresolvable account/plan',
    });
    return;
  }

  const credits = PAID_PLANS[plan]!.credits;
  try {
    // Unique index on stripe_ref makes replays a no-op (idempotency). Grant is
    // account-level, so key_id is left null.
    await env.DB.prepare(
      'INSERT INTO credit_ledger (account_id, delta, reason, stripe_ref) VALUES (?1, ?2, ?3, ?4)',
    )
      .bind(accountId, credits, `stripe:${plan}`, event.id)
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      log('stripe_event_replayed', { type: event.type, id: event.id });
      return;
    }
    throw err;
  }
  await invalidateAccountKeys(env, accountId);
  log('stripe_credits_granted', { accountId, plan, credits, eventId: event.id });
}

async function onSubscriptionChanged(env: CloudflareBindings, event: Stripe.Event): Promise<void> {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = customerIdOf(subscription.customer);
  if (!customerId) return;
  const link = await customerLink(env, customerId);
  if (!link) {
    log('stripe_event_skipped', { type: event.type, id: event.id, reason: 'unknown customer' });
    return;
  }

  const deleted = event.type === 'customer.subscription.deleted';
  const lookupKey = subscription.items?.data?.[0]?.price?.lookup_key ?? null;
  const plan = deleted ? 'free' : (lookupKey && planByLookupKey(lookupKey)) || link.plan || 'free';
  const status = deleted ? 'canceled' : subscription.status;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE stripe_customers SET plan = ?2, status = ?3, updated_at = datetime('now')
       WHERE stripe_customer_id = ?1`,
    ).bind(customerId, plan, status),
    env.DB.prepare(
      "UPDATE accounts SET plan = ?2, updated_at = datetime('now') WHERE id = ?1",
    ).bind(link.account_id, plan),
  ]);
  await invalidateAccountKeys(env, link.account_id);
  log('stripe_subscription_changed', { accountId: link.account_id, plan, status });
}

export async function handleStripeEvent(
  env: CloudflareBindings,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
      return onCheckoutCompleted(env, event);
    case 'invoice.paid':
      return onInvoicePaid(env, event);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return onSubscriptionChanged(env, event);
    default:
      log('stripe_event_unhandled', { type: event.type, id: event.id });
  }
}
