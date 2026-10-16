import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { requireApiKey } from './auth/middleware';
import { errorHandler, notFoundHandler } from './lib/envelope';
import { INDEXNOW_KEY_SHAPE } from './lib/indexnow';
import { meterCredits } from './metering/middleware';
import { rateLimit } from './metering/ratelimit';
import { canonicalHost, staticAssets } from './middleware/canonical';
import { noindexWalls } from './middleware/robots';
import { structuredLogger } from './middleware/logging';
import { restTraffic } from './middleware/traffic';
import { refreshAllSources } from './sources/store';
import { getSource } from './sources/registry';
import { accountRoutes } from './routes/account';
import { authRoutes } from './routes/auth';
import { billingRoutes } from './routes/billing';
import { changesRoutes } from './routes/changes';
import { dataRoutes } from './routes/data';
import { healthRoute } from './routes/health';
import { keysRoutes } from './routes/keys';
import { mcpOriginAllowed, mcpRoute } from './routes/mcp';
import { oauthRoutes } from './routes/oauth';
import { llmsRoute } from './routes/llms';
import { openapiRoute } from './routes/openapi';
import { feedsRoutes } from './routes/feeds';
import { statsRoutes } from './routes/stats';
import { usageRoute } from './routes/usage';
import { feedbackRoute } from './routes/feedback';
import { waitlistRoute } from './routes/waitlist';
import { x402Routes } from './x402/routes';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

// Order matters: canonical-host redirects first (www/http/trailing slash), then
// static files via the assets binding (their CSP comes from public/_headers and
// must not pass through secureHeaders below), then the dynamic middleware.
app.use('*', canonicalHost());
app.use('*', staticAssets());
// Every 401/402 wall answers `X-Robots-Tag: noindex` (Search Console 2026-10-15; middleware/robots.ts).
app.use('*', noindexWalls());
app.use('*', requestId());
app.use('*', structuredLogger());
// OAuth browser pages (/authorize, /authorize/login, /authorize/decision) run inside the popup
// a client such as claude.ai opens: they must keep `window.opener` (COOP unsafe-none, so the
// popup can report back) and their form POST must be allowed to redirect to the client's
// registered https redirect_uri (Chrome applies form-action to that redirect). Registered
// BEFORE the global secureHeaders below so its post-handler pass runs last and wins.
// 2026-10-04: with the strict defaults every claude.ai connect spun on "connecting…".
const oauthPageHeaders = secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  strictTransportSecurity: 'max-age=63072000; includeSubDomains',
  crossOriginOpenerPolicy: 'unsafe-none',
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    formAction: ["'self'", 'https:'],
    baseUri: ["'none'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  },
  xXssProtection: false,
});
app.use('/authorize', oauthPageHeaders);
app.use('/authorize/*', oauthPageHeaders);
// Dynamic-response hardening (JSON API). Static HTML gets the same via
// public/_headers, applied by the assets binding in staticAssets().
app.use(
  '*',
  secureHeaders({
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: 'max-age=63072000; includeSubDomains',
    // Strict CSP for Worker-generated responses: JSON API (no subresources),
    // the sign-in confirm page, and the /stats pages — none run inline scripts
    // (only inline <style> and ld+json data), so script-src 'self' holds.
    // Static HTML has its own per-page CSP in public/_headers.
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
    xXssProtection: false,
  }),
);
// CORS: allow cross-origin reads of the PUBLIC, bearer-or-payment-authed API
// (data, openapi, mcp, x402) so third-party sites/agents can call it. Cookie-
// authed routes (/v1/auth, /v1/account) and the Stripe webhook are deliberately
// EXCLUDED — same-origin only — so a future credentials:true can never open them.
// Never combine origin-reflection with credentials on the account routes.
const publicCors = cors();
app.use('/v1/data/*', publicCors);
app.use('/v1/changes/*', publicCors);
app.use('/v1/health', publicCors);
app.use('/openapi.json', publicCors);
// /mcp: CORS mirrors the transport's Origin allowlist (routes/mcp.ts) — a
// browser page outside it gets no CORS grant and a 403 from the route.
app.use('/mcp/*', (c, next) =>
  cors({ origin: (origin) => (mcpOriginAllowed(origin, c.env) ? origin : null) })(c, next),
);
app.use('/x402/*', publicCors);
// OAuth discovery and the token endpoint: fetched by Claude server-side, and
// by browser-based MCP clients (Inspector) cross-origin. No cookies involved.
app.use('/.well-known/oauth-*', publicCors);
app.use('/token', publicCors);

// Public: /v1/health, /openapi.json, key issuance, and the sources listing
// (GET /v1/data — discovery must work before signup). Authed: per-source data
// (rate-limited + metered) and /v1/usage (free to call).
// Note: '/v1/data/*' would also match the bare listing path, hence ':source'.
// Outermost of the per-source chain so `c.res` is the final outcome (a 401 from
// requireApiKey or a 429 from the rate limit is not counted as a call).
app.use('/v1/data/:source', restTraffic('rest_data'));
app.use('/v1/data/:source', requireApiKey());
// Per-source rate limit (source.rateLimit, default 60/60s) so a high-value niche
// can be throttled independently — resolved per request from the registry.
// Throttle by ACCOUNT (usageSubject), not keyId: quota is per-account, so keying
// the limit on the key would let one account mint many keys to multiply its rate.
app.use('/v1/data/:source', (c, next) => {
  const cfg = getSource(c.req.param('source') ?? '')?.rateLimit ?? { limit: 60, windowSeconds: 60 };
  return rateLimit({
    scope: 'data',
    limit: cfg.limit,
    windowSeconds: cfg.windowSeconds,
    identify: (ctx) => ctx.get('keyCtx')?.usageSubject ?? ctx.get('keyCtx')?.keyId ?? 'anonymous',
  })(c, next);
});
app.use('/v1/data/:source', meterCredits());
// Change feeds: same guards as data queries (key, per-source rate limit, metering).
app.use('/v1/changes/:source', restTraffic('rest_changes'));
app.use('/v1/changes/:source', requireApiKey());
app.use('/v1/changes/:source', (c, next) => {
  const cfg = getSource(c.req.param('source') ?? '')?.rateLimit ?? { limit: 60, windowSeconds: 60 };
  return rateLimit({
    scope: 'data',
    limit: cfg.limit,
    windowSeconds: cfg.windowSeconds,
    identify: (ctx) => ctx.get('keyCtx')?.usageSubject ?? ctx.get('keyCtx')?.keyId ?? 'anonymous',
  })(c, next);
});
app.use('/v1/changes/:source', meterCredits());
app.use('/v1/usage', requireApiKey());

app.route('/v1/health', healthRoute);
app.route('/v1/data', dataRoutes);
app.route('/v1/changes', changesRoutes);
app.route('/v1/keys', keysRoutes);
app.route('/v1/usage', usageRoute);
app.route('/v1/auth', authRoutes);
app.route('/v1/account', accountRoutes);
app.route('/v1/billing', billingRoutes);
app.route('/v1/waitlist', waitlistRoute);
app.route('/v1/feedback', feedbackRoute);
app.route('/mcp', mcpRoute);
// Lazy OAuth for /mcp: discovery documents, /authorize, /token (routes/oauth.ts).
app.route('/', oauthRoutes);
app.route('/x402', x402Routes);
app.route('/openapi.json', openapiRoute);
app.route('/llms.txt', llmsRoute);
// Google Search Console verification. Served by the Worker, NOT public/:
// the assets layer's html_handling 307s exact .html URLs to their pretty
// form, and Google's verifier requires a 200 at this precise path.
app.get('/googlecc09a1f1a708bfc8.html', (c) =>
  c.text('google-site-verification: googlecc09a1f1a708bfc8.html'),
);
// IndexNow key file (lib/indexnow.ts): proves control of the host to api.indexnow.org.
// The key is a plain var, so the route compares the requested name to it and lets any
// other *.txt fall through (llms.txt and robots.txt are shorter than the key shape anyway).
app.get('/:key{[A-Za-z0-9-]{8,128}\\.txt}', async (c, next) => {
  const key = (c.env.INDEXNOW_KEY ?? '').trim();
  if (!INDEXNOW_KEY_SHAPE.test(key) || c.req.param('key') !== `${key}.txt`) return next();
  return c.text(key);
});
app.route('/stats', statsRoutes);
// Keyless Atom feeds of the change feeds (routes/feeds.ts): the register on every RSS shelf.
app.route('/feeds', feedsRoutes);

app.onError(errorHandler);
app.notFound(notFoundHandler);

const scheduled: ExportedHandlerScheduledHandler<CloudflareBindings> = (controller, env, ctx) => {
  console.log(JSON.stringify({ level: 'info', event: 'scheduled', cron: controller.cron }));
  ctx.waitUntil(refreshAllSources(env, controller.cron));
};

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<CloudflareBindings>;
