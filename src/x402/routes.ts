import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { X402_CHANGES_PRICE_USD, X402_DEFAULT_PRICE_USD, publicBaseUrl } from '../lib/constants';
import { failure } from '../lib/envelope';
import { previewClientId } from '../mcp/preview';
import { handleChangesQuery } from '../routes/changes';
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
// runs until it has succeeded once (each cold request its own — see `startedPerRequest`), and
// the route declarations are built once.

const DEFAULT_PRICE_USD = X402_DEFAULT_PRICE_USD;
const DEFAULT_NETWORK = 'base';

const lanes = new Map<string, Promise<MiddlewareHandler>>();

// Log noise (gankdat `wave-log-cron-outcome-reading`, 2026-10-17): paymentMiddleware validates
// every route's Bazaar extension with Ajv, which compiles schemas with `new Function`; workerd
// forbids code generation, so each isolate start warned once per route (17 lines) although the
// extension is valid (CDP validate `valid: true`, 10-17) — and that warning was the newest line
// of every stale source's wave-log reading. Only that exact failure is muted; a real schema error
// still warns.
const CODEGEN_WARNING =
  /^x402: Route ".+" has an invalid bazaar extension: .*Code generation from strings disallowed/;
/** `warn` with that one warning dropped; every other call passes through unchanged. */
export function withoutCodegenWarning(
  warn: (...args: unknown[]) => void,
): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    if (typeof args[0] === 'string' && CODEGEN_WARNING.test(args[0])) return;
    warn(...args);
  };
}
// The same compile also logs an ERROR line (gankdat `x402-ajv-compile-log-noise`, 2026-10-18): Ajv's
// own `compileSchema` calls `logger.error("Error compiling schema, function code:", <source>)`
// before rethrowing, and @x402/extensions builds its Ajv without a `logger` option, so every
// isolate start wrote 17 error lines carrying the generated validator source — 11 of the 12
// uk-planning lines of the 10-17 wave-log reading, the loudest line in the Worker log, hiding
// any real error beside it. The compile cannot be skipped from here (`paymentMiddleware` runs
// `validateBazaarRouteExtensions` on every start) and under workerd it can only fail this way,
// so the one two-argument call Ajv makes is dropped; any other `console.error` passes through.
const AJV_COMPILE_ERROR = 'Error compiling schema, function code:';
/** `error` with Ajv's compile-failure line dropped; every other call passes through unchanged. */
export function withoutCodegenError(
  error: (...args: unknown[]) => void,
): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    if (args[0] === AJV_COMPILE_ERROR && args.length === 2 && typeof args[1] === 'string') return;
    // @x402/hono's own `console.error(error)` before it answers 500 is the only place the
    // start-up failure's Error object surfaces (see `guardedLane`); keep it for the report.
    if (args.length === 1 && args[0] instanceof Error) lastLibraryError = args[0];
    error(...args);
  };
}
let lastLibraryError: Error | null = null;
/** The Error the payment library last logged, taken once. */
function takeLibraryError(): Error | null {
  const error = lastLibraryError;
  lastLibraryError = null;
  return error;
}
let codegenNoiseMuted = false;
function muteCodegenNoise(): void {
  if (codegenNoiseMuted) return;
  codegenNoiseMuted = true;
  console.warn = withoutCodegenWarning(console.warn.bind(console));
  console.error = withoutCodegenError(console.error.bind(console));
}

async function buildLane(env: CloudflareBindings, lane: X402Lane): Promise<MiddlewareHandler> {
  muteCodegenNoise();
  const [
    { paymentMiddlewareFromHTTPServer },
    { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer },
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
  // The handshake is ours to run, not the library's (gankdat `x402-init-failure-cause-read`,
  // 2026-11-19). `paymentMiddleware` starts `initialize()` when it is built — inside whichever
  // request met the cold isolate — and every later request awaits that one promise. workerd
  // settles a promise only in the request that created it: when that first request ended early
  // (a sweeping client that hung up), everyone behind it got "This promise was created by a
  // request that has since ended, so it can never settle" — the whole of the 1, 2, 17, 52
  // failures a day since 11-13 (11 of 11 `x402_init_failed` lines in the 15 h to 11-19 09:10,
  // all attempt 1). So the library is told not to sync (`false`) and each request runs its own
  // handshake until one has succeeded (`startedPerRequest`).
  const httpServer = new x402HTTPResourceServer(
    server,
    bazaarRoutes(lane, declareDiscoveryExtension),
  );
  const middleware = paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);
  const started = startedPerRequest(() => httpServer.initialize());
  return async (c, next) => {
    await started(); // a throw here is before the handler: `guardedLane` retries it once
    return middleware(c, next);
  };
}

/**
 * A one-time start that no request ever awaits on another's behalf: until one call of `start`
 * has succeeded, every caller runs its own — a promise made in one request is never handed to
 * the next (workerd drops its settlement once the request that made it has ended). Concurrent
 * cold requests each pay one start; after the first success nobody calls it again. A failed
 * start is simply not remembered.
 */
export function startedPerRequest(start: () => Promise<void>): () => Promise<void> {
  let done = false;
  return async (): Promise<void> => {
    if (done) return;
    await start();
    done = true;
  };
}

/** What a client is told to wait when the payment server could not start (seconds). */
export const X402_INIT_RETRY_AFTER_S = 5;

export type LaneOutcome = { response: Response | void } | { unavailable: true };

/**
 * Runs the payment middleware so that a failure BEFORE the route handler ran — building the lane,
 * or the resource server's start-up handshake with the facilitator (`initializeHttpServer`, once
 * per isolate) — is reported, tried once more, and then answered as unavailable instead of thrown
 * (gankdat `x402-init-failure-answer`, 2026-11-18: the throw went out as a bare HTTP 500 on 1, 2,
 * 17 and 52 requests a day from 11-13, on every x402 route, and the logged line held only stack
 * frames). Nothing has been verified, served or settled at that point, so the second attempt
 * cannot charge or serve twice. A throw once the handler has been entered passes through
 * unchanged: that is a data error after a verified payment, and repeating it could.
 * A failure may also come back as a RESPONSE rather than a throw (`failureOf`); it is treated the
 * same way, and only while the handler has not been entered.
 */
export async function guardedLane(
  run: (next: () => Promise<void>) => Promise<Response | void>,
  next: () => Promise<void>,
  report: (error: unknown, attempt: number) => void,
  failureOf: (response: Response) => unknown = () => null,
): Promise<LaneOutcome> {
  let entered = false;
  const tracked = (): Promise<void> => {
    entered = true;
    return next();
  };
  for (let attempt = 1; ; attempt += 1) {
    let failure: unknown;
    try {
      const response = await run(tracked);
      // The library does not throw its start-up failure: it logs it and RETURNS a 500 (or a 502
      // for a facilitator refusal). Live on 11-18 17:52, 18:06 and 18:20 the first version of this
      // guard, which only caught throws, let six such 500s through. `failureOf` names a response
      // that is such a failure; it is one only while the handler has not been entered.
      failure = !entered && response instanceof Response ? failureOf(response) : null;
      if (failure === null || failure === undefined) return { response };
    } catch (error) {
      if (entered) throw error;
      failure = error;
    }
    report(failure, attempt);
    if (attempt >= 2) return { unavailable: true };
  }
}

// The paid lane, shared by the data routes and the change feeds (`/x402/changes/:source`,
// gankdat `x402-change-feed-route`, 2026-11-05: the same middleware, one route table).
const paidLane: MiddlewareHandler<AppEnv> = async (c, next) => {
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
    console.error(JSON.stringify({ level: 'error', event: 'x402_misconfigured', price, network }));
    return c.json(failure('unavailable', 'x402 is misconfigured; retry later'), 503);
  }

  const lane: X402Lane = { baseUrl: publicBaseUrl(c.env), payTo: wallet, price, network };
  const facilitatorKey = c.env.CDP_API_KEY_ID ? 'cdp' : (c.env.X402_FACILITATOR_URL ?? '');
  const key = [lane.baseUrl, wallet, price, network, facilitatorKey].join('|');
  const laneMiddleware = (): Promise<MiddlewareHandler> => {
    let middleware = lanes.get(key);
    if (!middleware) {
      middleware = buildLane(c.env, lane).catch((error: unknown) => {
        lanes.delete(key); // a failed build is retried by the next request, not cached
        throw error;
      });
      lanes.set(key, middleware);
    }
    return middleware;
  };

  takeLibraryError(); // an Error logged for an earlier request is not this one's
  const guarded = await guardedLane(
    async (tracked) => (await laneMiddleware())(c, tracked),
    next,
    (error, attempt) => {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'x402_init_failed',
          attempt,
          path: c.req.path,
          name: err.name,
          message: err.message.slice(0, 500),
          cause: err.cause === undefined ? undefined : String(err.cause).slice(0, 300),
        }),
      );
    },
    // @x402/hono 2.29 answers its own failures before the handler: `internalErrorResponse` (500,
    // after `console.error(error)`) for a failed start-up or request processing, and
    // `facilitatorErrorResponse` (502, the facilitator's message in the body).
    (response) => {
      if (response.status !== 500 && response.status !== 502) return null;
      return takeLibraryError() ?? new Error(`payment middleware answered HTTP ${response.status}`);
    },
  );
  if ('unavailable' in guarded) {
    c.header('Retry-After', String(X402_INIT_RETRY_AFTER_S));
    return c.json(
      failure(
        'unavailable',
        `x402 payment terms are briefly unavailable; retry in ${X402_INIT_RETRY_AFTER_S} s`,
      ),
      503,
    );
  }
  const response = guarded.response;
  // The middleware returns its own 402/5xx; on a settled payment it sets c.res (the
  // data response plus the PAYMENT-RESPONSE receipt). Only that receipt marks a sale.
  const outcome = response ?? c.res;
  if (outcome.ok && outcome.headers.has('PAYMENT-RESPONSE')) {
    const slug = c.req.param('source') ?? '';
    const paidPrice = c.req.path.startsWith('/x402/changes/')
      ? X402_CHANGES_PRICE_USD
      : getSource(slug)?.x402PriceUsd || price;
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
};

export const x402Routes = new Hono<AppEnv>()
  .use('/data/:source', paidLane)
  .use('/changes/:source', paidLane)
  .get('/data/:source', handleSourceQuery)
  .get('/changes/:source', handleChangesQuery);
