import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { withoutCodegenWarning } from '../src/x402/routes';
import type { ErrorEnvelope } from '../src/lib/envelope';

const X402_URL = 'https://example.com/x402/data/uk-planning';
const LOOKUP_URL = 'https://example.com/x402/data/uk-company-profiles';
const TEST_WALLET = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const FACILITATOR = 'https://facilitator.test';
const NETWORK = 'eip155:84532'; // base-sepolia in x402 v2's CAIP-2 naming
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** x402 v2 payment-required document, as carried base64-encoded in PAYMENT-REQUIRED. */
interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }[];
  extensions?: {
    bazaar?: {
      info: {
        input: { type: string; method?: string; queryParams?: Record<string, string> };
        output?: { type: string; example: { ok: boolean; data: unknown[] } };
      };
      schema: {
        properties: {
          input: { properties: { queryParams: { properties: Record<string, unknown> } } };
        };
      };
    };
  };
}

function fromBase64Json<T>(value: string | null): T {
  expect(value, 'base64 header present').toBeTruthy();
  const bytes = Uint8Array.from(atob(value!), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

function toBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes));
}

/** Run a request through the real worker with x402 env vars switched on. */
async function litFetch(
  url: string,
  init?: RequestInit,
  overrides: Partial<CloudflareBindings> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const litEnv = {
    ...env,
    X402_WALLET_ADDRESS: TEST_WALLET,
    X402_NETWORK: 'base-sepolia',
    // The resource server syncs with the facilitator (GET /supported) on its first
    // request, so every lit test points it at the stub below — never the network.
    X402_FACILITATOR_URL: FACILITATOR,
    ...overrides,
  } as CloudflareBindings;
  const res = await worker.fetch(new Request(url, init), litEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * One stub, every outbound surface: the facilitator's /supported handshake (answered
 * for all tests — the lane is built once per configuration and keeps it), /verify and
 * /settle when a test supplies them, and the data origin. Anything else throws loudly.
 */
function stubFacilitator(handlers: {
  verify?: () => Response;
  settle?: () => Response;
  origin?: (url: string) => Response | undefined;
}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.startsWith(`${FACILITATOR}/supported`)) {
        return Promise.resolve(
          Response.json({
            kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
            extensions: ['bazaar'],
            signers: {},
          }),
        );
      }
      if (url === `${FACILITATOR}/verify` && handlers.verify) {
        return Promise.resolve(handlers.verify());
      }
      if (url === `${FACILITATOR}/settle` && handlers.settle) {
        return Promise.resolve(handlers.settle());
      }
      const origin = handlers.origin?.(url);
      if (origin) return Promise.resolve(origin);
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }),
  );
  return calls;
}

async function paymentRequired(url: string): Promise<PaymentRequired> {
  const res = await litFetch(url);
  expect(res.status).toBe(402);
  return fromBase64Json<PaymentRequired>(res.headers.get('PAYMENT-REQUIRED'));
}

/** A structurally valid v2 exact/evm payment for the first accepted requirement. */
function paymentFor(required: PaymentRequired): string {
  const accepted = required.accepts[0]!;
  return toBase64Json({
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: {
        from: PAYER,
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: '0',
        validBefore: '99999999999',
        nonce: `0x${'33'.repeat(32)}`,
      },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/x402/data/:source', () => {
  it('is dark (404) while X402_WALLET_ADDRESS is unset', async () => {
    const res = await SELF.fetch(X402_URL);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('not_found');
  });

  it('answers 402 with the v2 payment-required header naming wallet, price and network', async () => {
    stubFacilitator({});
    const res = await litFetch(X402_URL);
    expect(res.status).toBe(402);
    // v2 puts the terms in the header; the body is the platform's error envelope.
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('payment_required');
    expect(body.error.message).toContain('PAYMENT-REQUIRED');

    const required = fromBase64Json<PaymentRequired>(res.headers.get('PAYMENT-REQUIRED'));
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    const accept = required.accepts[0]!;
    expect(accept.scheme).toBe('exact');
    expect(accept.payTo.toLowerCase()).toBe(TEST_WALLET);
    expect(accept.network).toBe(NETWORK);
    expect(accept.asset).toBe(SEPOLIA_USDC);
    expect(accept.amount).toBe('5000'); // $0.005 in USDC atomic units
    expect(required.resource.url).toBe('https://gankdat.com/x402/data/uk-planning');
    expect(required.resource.description).toContain('planning');
    expect(required.resource.mimeType).toBe('application/json');
  });

  it('declares Bazaar discovery metadata generated from the source registry', async () => {
    stubFacilitator({});
    const required = await paymentRequired(X402_URL);
    const bazaar = required.extensions?.bazaar;
    expect(bazaar, 'extensions.bazaar declared').toBeTruthy();
    expect(bazaar!.info.input.type).toBe('http');
    expect(bazaar!.info.input.method).toBe('GET');
    expect(bazaar!.info.input.queryParams).toEqual({ per_page: 5 });
    // The query schema is the source's zod params plus the platform's page/per_page/q.
    const params = bazaar!.schema.properties.input.properties.queryParams.properties;
    expect(Object.keys(params)).toEqual(
      expect.arrayContaining(['authority', 'decision_date_after', 'page', 'per_page', 'q']),
    );
    // The output example is the success envelope with one schema-shaped record.
    expect(bazaar!.info.output?.type).toBe('json');
    expect(bazaar!.info.output?.example.ok).toBe(true);
    expect(bazaar!.info.output?.example.data).toHaveLength(1);
  });

  it('prices a lookup source at its own x402PriceUsd and names its key in the example', async () => {
    stubFacilitator({});
    const required = await paymentRequired(LOOKUP_URL);
    expect(required.accepts[0]?.amount).toBe('10000'); // uk-company-profiles: $0.01
    expect(required.extensions?.bazaar?.info.input.queryParams).toEqual({
      company_number: '00000006',
    });
  });

  it('rejects a malformed PAYMENT-SIGNATURE header with 402, not a crash', async () => {
    stubFacilitator({}); // any verify/settle call would throw loudly
    const res = await litFetch(X402_URL, {
      headers: { 'PAYMENT-SIGNATURE': 'not-a-real-payment' },
    });
    expect(res.status).toBe(402);
  });

  it('does not leak the paid lane into the authed REST lane', async () => {
    // Same slug via /v1 still requires an API key even when x402 is lit.
    const res = await litFetch('https://example.com/v1/data/uk-planning');
    expect(res.status).toBe(401);
  });

  // Happy path: structurally-valid payment → facilitator verifies → data served
  // → facilitator settles → receipt in PAYMENT-RESPONSE. The facilitator is
  // stubbed (its /verify + /settle are the only crypto in the flow); the real
  // settlement was proven live on base-sepolia and base mainnet under x402 v1.
  it('serves data and returns a settlement receipt for a verified payment', async () => {
    const TX_HASH = `0x${'ab'.repeat(32)}`;
    stubFacilitator({});
    const required = await paymentRequired(X402_URL);
    vi.unstubAllGlobals();

    const calls = stubFacilitator({
      verify: () => Response.json({ isValid: true, payer: PAYER }),
      settle: () =>
        Response.json({ success: true, transaction: TX_HASH, network: NETWORK, payer: PAYER }),
      origin: (url) =>
        url.startsWith('https://www.planning.data.gov.uk/')
          ? Response.json({
              entities: [
                { entity: 1, reference: 'A/1', 'organisation-entity': 109, description: 'x' },
              ],
              links: {},
              count: 1,
            })
          : undefined,
    });

    const res = await litFetch(X402_URL, {
      headers: { 'PAYMENT-SIGNATURE': paymentFor(required) },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);

    // Settlement receipt: base64 JSON in PAYMENT-RESPONSE.
    const receipt = fromBase64Json<{ success: boolean; transaction: string }>(
      res.headers.get('PAYMENT-RESPONSE'),
    );
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBe(TX_HASH);

    // Exactly one verify and one settle, in that order (the /supported handshake
    // happened once, when this configuration's lane was first built).
    const facilitatorCalls = calls.filter(
      (u) => u.startsWith(FACILITATOR) && !u.includes('/supported'),
    );
    expect(facilitatorCalls).toEqual([`${FACILITATOR}/verify`, `${FACILITATOR}/settle`]);
  });

  it('does not settle when the facilitator rejects the payment', async () => {
    stubFacilitator({});
    const required = await paymentRequired(X402_URL);
    vi.unstubAllGlobals();

    const calls = stubFacilitator({
      verify: () => Response.json({ isValid: false, invalidReason: 'insufficient_funds' }),
    });
    const res = await litFetch(X402_URL, {
      headers: { 'PAYMENT-SIGNATURE': paymentFor(required) },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull();
    // no settle, no origin hit
    expect(calls.filter((u) => !u.includes('/supported'))).toEqual([`${FACILITATOR}/verify`]);
  });

  // #11 — a bad price/network env override returns a clean 503, not a 500 from
  // the route builder throwing on every request.
  it('returns 503 (not 500) when misconfigured', async () => {
    const badPrice = await litFetch(X402_URL, undefined, { X402_PRICE_USD: '0' });
    expect(badPrice.status).toBe(503);
    expect(((await badPrice.json()) as ErrorEnvelope).error.code).toBe('unavailable');

    const badNetwork = await litFetch(X402_URL, undefined, { X402_NETWORK: 'ethereum' });
    expect(badNetwork.status).toBe(503);
  });
});

// Log noise (2026-10-17, `wave-log-cron-outcome-reading`): @x402/hono's Ajv validation warns on
// every route under workerd ("Code generation from strings disallowed") although the Bazaar
// extension is valid; only that exact warning is muted, every other warning still reaches the log.
describe('withoutCodegenWarning', () => {
  it('drops the workerd codegen warning and nothing else', () => {
    const seen: unknown[][] = [];
    const warn = withoutCodegenWarning((...args) => {
      seen.push(args);
    });
    warn(
      'x402: Route "GET /x402/data/uk-planning" has an invalid bazaar extension: Schema validation failed: Code generation from strings disallowed for this context',
    );
    warn('x402: Route "GET /x402/data/uk-planning" has an invalid bazaar extension: missing input');
    warn('V2 discovery extension extraction failed: boom', { detail: 1 });
    expect(seen).toEqual([
      ['x402: Route "GET /x402/data/uk-planning" has an invalid bazaar extension: missing input'],
      ['V2 discovery extension extraction failed: boom', { detail: 1 }],
    ]);
  });
});
