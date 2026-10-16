import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { X402_DEFAULT_PRICE_USD, publicBaseUrl } from '../lib/constants';
import { failure } from '../lib/envelope';
import { previewClientId } from '../mcp/preview';
import { handleSourceQuery } from '../routes/data';
import { getSource } from '../sources/registry';
import type { AppEnv } from '../types';
import { bazaarRoutes, isX402Network, X402_NETWORKS, type X402Lane } from './bazaar';

// Pay-per-request lane for agents with no account: payment IS the auth, so no
// API key and no credit metering here. Dark by default — everything 404s until
// X402_WALLET_ADDRESS is configured (PRD: ships dark, wallet is open question).
//
// Protocol (x402 v2, @x402/hono since 2026-10-14 — gankdat `x402-bazaar-listing`):
// unpaid request → 402 whose PAYMENT-REQUIRED header carries the base64 JSON
// payment-required document (accepts[], resource, and the Bazaar discovery
// extension generated from the registry in bazaar.ts) → agent pays → retries with
// PAYMENT-SIGNATURE → the middleware verifies with the facilitator → handler runs →
// settlement receipt in PAYMENT-RESPONSE. v1 clients (X-PAYMENT, requirements in
// the body) are no longer served: the lane had 0 payments in three months and every
// resource the CDP catalogue indexes is v2.
//
// The x402 packages (and viem beneath @x402/evm, most of the bundle) are imported
// lazily on the first lit request: loading them up front cost each of the test files
// ≈2.4 s of module evaluation (gankdat-test-setup, 2026-10-06) and weighs on every
// Worker cold start while the lane ships dark. The resource server is then kept per
// configuration for the isolate's life: its facilitator handshake (GET /supported)
// runs once, not per request, and the 17 route declarations are built once.

const DEFAULT_PRICE_USD = X402_DEFAULT_PRICE_USD;
const DEFAULT_NETWORK = 'base';

const lanes = new Map<string, Promise<MiddlewareHandler>>();

async function buildLane(env: CloudflareBindings, lane: X402Lane): Promise<MiddlewareHandler> {
  const [
    { paymentMiddleware },
    { HTTPFacilitatorClient, x402ResourceServer },
    { ExactEvmScheme },
    { bazaarResourceServerExtension, declareDiscoveryExtension },
    { createFacilitatorConfig },
  ] = await Promise.all([
    import('@x402/hono'),
    import('@x402/core/server'),
    import('@x402/evm/exact/server'),
    import('@x402/extensions/bazaar'),
    import('@coinbase/x402'),
  ]);

  // Facilitator (verify + settle, and the Bazaar's indexer): Coinbase CDP when its
  // credentials are set (mainnet Base; the only one that indexes), else an explicit
  // URL, else the public x402.org facilitator (Base Sepolia only — probing).
  const facilitator =
    env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET
      ? createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET)
      : env.X402_FACILITATOR_URL
        ? { url: env.X402_FACILITATOR_URL }
        : undefined;
  const server = new x402ResourceServer(new HTTPFacilitatorClient(facilitator))
    .register(X402_NETWORKS[lane.network], new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  return paymentMiddleware(bazaarRoutes(lane, declareDiscoveryExtension), server);
}

export const x402Routes = new Hono<AppEnv>()
  .use('/data/:source', async (c, next) => {
    const wallet = c.env.X402_WALLET_ADDRESS;
    if (!wallet) {
      return c.json(failure('not_found', `No route for ${c.req.method} ${c.req.path}`), 404);
    }

    const price = c.env.X402_PRICE_USD || DEFAULT_PRICE_USD;
    const network = c.env.X402_NETWORK || DEFAULT_NETWORK;
    // Validate the operator-supplied overrides up front: the route builder THROWS
    // on a bad price/network, which would 500 every request (paid and unpaid).
    // A clean 503 + log names the misconfiguration instead.
    if (!/^\$\d+(\.\d+)?$/.test(price) || !isX402Network(network)) {
      console.error(
        JSON.stringify({ level: 'error', event: 'x402_misconfigured', price, network }),
      );
      return c.json(failure('unavailable', 'x402 is misconfigured; retry later'), 503);
    }

    const lane: X402Lane = { baseUrl: publicBaseUrl(c.env), payTo: wallet, price, network };
    const facilitatorKey = c.env.CDP_API_KEY_ID ? 'cdp' : (c.env.X402_FACILITATOR_URL ?? '');
    const key = [lane.baseUrl, wallet, price, network, facilitatorKey].join('|');
    let middleware = lanes.get(key);
    if (!middleware) {
      middleware = buildLane(c.env, lane).catch((error: unknown) => {
        lanes.delete(key); // a failed build is retried by the next request, not cached
        throw error;
      });
      lanes.set(key, middleware);
    }

    const response = await (await middleware)(c, next);
    // The middleware returns its own 402/5xx; on a settled payment it sets c.res (the
    // data response plus the PAYMENT-RESPONSE receipt). Only that receipt marks a sale.
    const outcome = response ?? c.res;
    if (outcome.ok && outcome.headers.has('PAYMENT-RESPONSE')) {
      const slug = c.req.param('source') ?? '';
      const paidPrice = getSource(slug)?.x402PriceUsd || price;
      console.log(
        JSON.stringify({ level: 'info', event: 'x402_paid', path: c.req.path, price: paidPrice }),
      );
      // Revenue analytics (90-day history via `npm run traffic`) — Workers
      // Logs alone rotates out in days. UA names the paying agent; blob6 is the
      // same hashed IP+UA client id the preview wall writes, so the Daily numbers
      // row can tell whether a wall-hitter came back here (`after wall 1h`,
      // gankdat preview-wall-next-steps, 2026-10-11). No raw IP. The owner's own
      // indexing payment and the runner's probe send `gankdat-x402-probe/…` as
      // the UA; the metrics runner counts those as internal, never as sales.
      const userAgent = c.req.header('User-Agent') ?? '';
      c.env.TRAFFIC.writeDataPoint({
        blobs: [
          'x402_paid',
          userAgent,
          c.req.path,
          '',
          slug,
          await previewClientId(c.req.header('CF-Connecting-IP') ?? 'unknown', userAgent),
        ],
        doubles: [1],
        indexes: ['x402_paid'],
      });
    }
    return response;
  })
  .get('/data/:source', handleSourceQuery);
