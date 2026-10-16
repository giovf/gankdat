import Stripe from 'stripe';

// Workers-compatible Stripe client: fetch HTTP client + SubtleCrypto webhook
// verification (Node's crypto module is unavailable in the Workers runtime).
// Billing is dark until STRIPE_SECRET_KEY is configured — callers must handle null.
export function stripeClient(env: CloudflareBindings): Stripe | null {
  if (!env.STRIPE_SECRET_KEY) return null;
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export const webhookCryptoProvider = Stripe.createSubtleCryptoProvider();
