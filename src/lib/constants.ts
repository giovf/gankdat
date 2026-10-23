export const APP_VERSION = '0.25.3';
/** x402 pay-per-call price per request unless X402_PRICE_USD or a source's x402PriceUsd says otherwise. */
export const X402_DEFAULT_PRICE_USD = '$0.005';

// Placeholder free-tier size (PRD open question #5 — pricing is launch config).
export const FREE_TIER_CREDITS = 250;

// Public base URL. API_BASE_URL is the brand-domain default; PUBLIC_BASE_URL
// overrides it at runtime for the correctness-critical URLs (magic-link sign-in
// + Stripe redirects) so pointing a custom domain (e.g. gankdat.com) at the
// Worker is a config change, not a code change.
export const API_BASE_URL = 'https://gankdat.com';
export const DOCS_ERRORS_URL = `${API_BASE_URL}/docs`;

export function publicBaseUrl(env: CloudflareBindings): string {
  return env.PUBLIC_BASE_URL || API_BASE_URL;
}
