#!/usr/bin/env node
// One-time Stripe bootstrap (TEST MODE unless you explicitly pass a live key —
// live-mode object creation is an ask-first operation per CLAUDE.md).
//
//   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-setup.mjs
//
// Creates one product per paid plan with a monthly price carrying a stable
// lookup_key (the Worker resolves prices by lookup_key, so ids never need to
// be configured) and the credit amount in metadata for human reference.
// Plan data comes from the SAME src/billing/plans.json the app uses, so Stripe
// prices/credits can't drift from what the app validates and grants. Change
// prices there. Re-running is safe: existing lookup_keys are skipped.

import Stripe from 'stripe';
import paidPlans from '../src/billing/plans.json' with { type: 'json' };

// Stripe product name: the plan's customer-facing displayName from plans.json,
// falling back to the capitalized slug for entries without one.
const displayName = (key) =>
  paidPlans[key]?.displayName ?? key.charAt(0).toUpperCase() + key.slice(1);
const PLANS = Object.entries(paidPlans).map(([key, p]) => ({
  name: displayName(key),
  lookupKey: p.lookupKey,
  gbp: p.gbpPerMonth,
  usd: p.usdPerMonth,
  eur: p.eurPerMonth,
  credits: p.credits,
}));

// GBP is the default currency (UK-based operator); USD/EUR ride along as
// currency_options and Checkout auto-selects by customer location.
const priceBody = (plan, productId) => ({
  product: productId,
  currency: 'gbp',
  unit_amount: plan.gbp * 100,
  currency_options: {
    usd: { unit_amount: plan.usd * 100 },
    eur: { unit_amount: plan.eur * 100 },
  },
  recurring: { interval: 'month' },
  lookup_key: plan.lookupKey,
  metadata: { credits: String(plan.credits) },
});

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY (test mode: sk_test_...) and re-run.');
  process.exit(1);
}
if (!key.startsWith('sk_test_') && process.env.STRIPE_ALLOW_LIVE !== '1') {
  console.error('Refusing non-test key: live-mode object creation is ask-first (CLAUDE.md).');
  console.error('If the operator has explicitly approved, re-run with STRIPE_ALLOW_LIVE=1.');
  process.exit(1);
}

const stripe = new Stripe(key);

const existing = await stripe.prices.list({
  lookup_keys: PLANS.map((p) => p.lookupKey),
  limit: 100,
});
const byLookup = new Map(existing.data.map((p) => [p.lookup_key, p]));

for (const plan of PLANS) {
  const current = byLookup.get(plan.lookupKey);
  if (current && current.currency === 'gbp') {
    console.log(`= ${plan.lookupKey} already GBP-default, skipping`);
    continue;
  }
  if (current) {
    // Currency migration: a Price's currency is immutable, so mint a fresh
    // GBP-default price on the SAME product, move the lookup key to it, and
    // retire the old price (existing subscriptions keep working on it).
    await stripe.prices.create({ ...priceBody(plan, current.product), transfer_lookup_key: true });
    await stripe.prices.update(current.id, { active: false });
    console.log(`~ migrated ${plan.lookupKey} to GBP default (£${plan.gbp}/mo), old price retired`);
    continue;
  }
  const product = await stripe.products.create({
    name: `gankdat ${plan.name}`,
    // Stripe Tax category: SaaS — business use (metered access to a hosted
    // service, sold B2B). Set here so live-mode setup inherits it.
    tax_code: 'txcd_10103001',
    metadata: { credits: String(plan.credits) },
  });
  await stripe.prices.create(priceBody(plan, product.id));
  console.log(`+ created ${plan.name} (£${plan.gbp}/mo, ${plan.credits} credits)`);
}
console.log('Done. Point STRIPE_WEBHOOK_SECRET at a webhook for /v1/billing/webhook.');
