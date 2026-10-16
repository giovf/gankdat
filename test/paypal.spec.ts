import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';
import { currentPeriod } from '../src/metering/counters';
import { authedFetch, bearer, issueKey } from './helpers/auth';
import { planningResponse, stubOrigins } from './helpers/origin-mock';

// Credit packs via PayPal (sandbox) — billing/paypal.ts, metering/budget.ts,
// the buy_credits / confirm_credit_purchase MCP tools. PayPal's API is stubbed
// at the fetch layer; the Worker's own routes run for real.

const BASE = 'https://example.com';
const ORDERS_URL = `${BASE}/v1/billing/paypal/orders`;
const USAGE_URL = `${BASE}/v1/usage`;
const DATA_URL = `${BASE}/v1/data/uk-planning?per_page=1`;
const MCP_URL = `${BASE}/mcp`;

type UsageBody = SuccessEnvelope<{
  plan: string;
  used: number;
  granted: number;
  remaining: number;
  topup: number;
  alerts: string[];
}>;
type OrderBody = SuccessEnvelope<{
  order_id: string;
  approve_url: string;
  pack: string;
  credits: number;
  amount_usd: string;
}>;
type CaptureBody = SuccessEnvelope<{
  order_id: string;
  status: string;
  credits_added: number;
  topup: number;
}>;

interface PayPalStub {
  calls: { path: string; body: unknown }[];
  /** Orders minted so far — ids are ORDER1, ORDER2, … like PayPal's unique ids. */
  orders: number;
  /** What the capture endpoint answers; default COMPLETED. */
  capture: () => Response;
}

/** Stub the sandbox API: token, create order, capture. Everything else throws. */
function stubPayPal(opts: Partial<Pick<PayPalStub, 'capture'>> = {}): PayPalStub {
  const stub: PayPalStub = {
    calls: [],
    orders: 0,
    capture:
      opts.capture ??
      (() =>
        Response.json({
          id: 'ORDER1',
          status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED' }] } }],
        })),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api-m.sandbox.paypal.com/')) {
        throw new Error(`unexpected outbound fetch in test: ${url}`);
      }
      const path = url.slice('https://api-m.sandbox.paypal.com'.length);
      const raw = init?.body;
      const body = typeof raw === 'string' && raw.startsWith('{') ? JSON.parse(raw) : raw;
      stub.calls.push({ path, body });
      if (path === '/v1/oauth2/token') {
        const auth = new Headers(init?.headers).get('Authorization') ?? '';
        expect(auth).toBe(`Basic ${btoa('test-paypal-client:test-paypal-secret')}`);
        return Response.json({ access_token: 'A21.token', expires_in: 32400 });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer A21.token');
      if (path === '/v2/checkout/orders') {
        const id = `ORDER${(stub.orders += 1)}`;
        return Response.json({
          id,
          status: 'PAYER_ACTION_REQUIRED',
          links: [
            { href: `https://api-m.sandbox.paypal.com/v2/checkout/orders/${id}`, rel: 'self' },
            { href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: 'payer-action' },
          ],
        });
      }
      if (/^\/v2\/checkout\/orders\/ORDER\d+\/capture$/.test(path)) return stub.capture();
      throw new Error(`unstubbed PayPal endpoint: ${path}`);
    }),
  );
  return stub;
}

async function createOrder(key: string, pack = 'pack_1k'): Promise<Response> {
  return SELF.fetch(ORDERS_URL, {
    method: 'POST',
    headers: { ...bearer(key), 'content-type': 'application/json' },
    body: JSON.stringify({ pack }),
  });
}

async function capture(key: string, orderId = 'ORDER1'): Promise<Response> {
  return SELF.fetch(`${ORDERS_URL}/${orderId}/capture`, { method: 'POST', headers: bearer(key) });
}

async function usage(key: string): Promise<UsageBody['data']> {
  return ((await (await SELF.fetch(USAGE_URL, { headers: bearer(key) })).json()) as UsageBody).data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('credit packs', () => {
  it('lists the packs without a key', async () => {
    const res = await SELF.fetch(`${BASE}/v1/billing/paypal/packs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<{
      packs: { pack: string; credits: number; usd: string }[];
      sandbox: boolean;
    }>;
    expect(body.data.sandbox).toBe(true);
    expect(body.data.packs.map((p) => p.pack)).toEqual(['pack_1k', 'pack_5k', 'pack_20k']);
    expect(body.data.packs[0]).toEqual({ pack: 'pack_1k', credits: 1000, usd: '8.00' });
  });

  it('needs a key and a known pack', async () => {
    stubPayPal();
    const anon = await SELF.fetch(ORDERS_URL, { method: 'POST', body: '{"pack":"pack_1k"}' });
    expect(anon.status).toBe(401);
    const { key } = await issueKey();
    const bad = await createOrder(key, 'pack_1m');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as ErrorEnvelope).error.message).toContain('pack_1k');
  });

  it('creates a sandbox order for the account and returns the approval link', async () => {
    const stub = stubPayPal();
    const { key, id } = await issueKey();
    const res = await createOrder(key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrderBody;
    expect(body.data).toMatchObject({
      order_id: 'ORDER1',
      approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
      pack: 'pack_1k',
      credits: 1000,
      amount_usd: '8.00',
    });

    // The order names the pack, the amount and the account; returns land on our routes.
    const create = stub.calls.find((c) => c.path === '/v2/checkout/orders')?.body as {
      intent: string;
      purchase_units: { reference_id: string; custom_id: string; amount: { value: string } }[];
      payment_source: { paypal: { experience_context: { return_url: string } } };
    };
    const accountId = (
      await env.DB.prepare('SELECT account_id FROM api_keys WHERE id = ?1')
        .bind(id)
        .first<{ account_id: string }>()
    )?.account_id;
    expect(create.intent).toBe('CAPTURE');
    expect(create.purchase_units[0]).toMatchObject({
      reference_id: 'pack_1k',
      custom_id: accountId,
      amount: { value: '8.00' },
    });
    expect(create.payment_source.paypal.experience_context.return_url).toBe(
      'https://gankdat.com/v1/billing/paypal/return',
    );
    const row = await env.DB.prepare(
      'SELECT status, credits FROM paypal_orders WHERE order_id = ?1',
    )
      .bind('ORDER1')
      .first();
    expect(row).toEqual({ status: 'created', credits: 1000 });

    // The token is cached: a second order makes one more PayPal call, not two.
    const before = stub.calls.length;
    expect((await createOrder(key)).status).toBe(200);
    expect(stub.calls.length).toBe(before + 1);
  });

  it('captures once: credits land on the top-up balance, replays add nothing', async () => {
    stubPayPal();
    const { key, id } = await issueKey();
    expect((await createOrder(key)).status).toBe(200);

    const first = await capture(key);
    expect(first.status).toBe(200);
    expect(((await first.json()) as CaptureBody).data).toEqual({
      order_id: 'ORDER1',
      status: 'completed',
      credits_added: 1000,
      topup: 1000,
    });
    expect(await usage(key)).toMatchObject({ used: 0, granted: 250, remaining: 1250, topup: 1000 });

    const again = await capture(key);
    expect(((await again.json()) as CaptureBody).data).toMatchObject({
      status: 'already_completed',
      credits_added: 0,
      topup: 1000,
    });
    expect((await usage(key)).topup).toBe(1000);

    const accountId = (
      await env.DB.prepare('SELECT account_id FROM api_keys WHERE id = ?1')
        .bind(id)
        .first<{ account_id: string }>()
    )?.account_id;
    const ledger = await env.DB.prepare(
      "SELECT COUNT(*) AS n, SUM(delta) AS total FROM credit_ledger WHERE account_id = ?1 AND reason = 'paypal:pack_1k'",
    )
      .bind(accountId)
      .first<{ n: number; total: number }>();
    expect(ledger).toEqual({ n: 1, total: 1000 });
    const row = await env.DB.prepare(
      'SELECT status, capture_id FROM paypal_orders WHERE order_id = ?1',
    )
      .bind('ORDER1')
      .first();
    expect(row).toEqual({ status: 'completed', capture_id: 'CAP1' });
  });

  it('answers 409 while the buyer has not approved, and 404 for another account’s order', async () => {
    stubPayPal({
      capture: () =>
        Response.json(
          { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] },
          { status: 422 },
        ),
    });
    const { key } = await issueKey();
    expect((await createOrder(key)).status).toBe(200);
    const res = await capture(key);
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorEnvelope).error.code).toBe('payment_required');
    expect((await usage(key)).topup).toBe(0);

    const other = await issueKey();
    expect((await capture(other.key)).status).toBe(404);
  });

  it('captures on the buyer’s return from PayPal and lands on the account page', async () => {
    stubPayPal();
    const { key } = await issueKey();
    expect((await createOrder(key)).status).toBe(200);

    const back = await SELF.fetch(`${BASE}/v1/billing/paypal/return?token=ORDER1&PayerID=X`, {
      redirect: 'manual',
    });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('https://gankdat.com/account?paypal=success');
    expect((await usage(key)).topup).toBe(1000);

    const unknown = await SELF.fetch(`${BASE}/v1/billing/paypal/return?token=NOPE`, {
      redirect: 'manual',
    });
    expect(unknown.headers.get('location')).toBe('https://gankdat.com/account?paypal=error');
    const cancel = await SELF.fetch(`${BASE}/v1/billing/paypal/cancel`, { redirect: 'manual' });
    expect(cancel.headers.get('location')).toBe('https://gankdat.com/account?paypal=cancelled');
  });
});

describe('top-up spending', () => {
  it('pays from the pack once the plan allowance is gone, then 402 names the pack', async () => {
    stubOrigins({ planning: () => planningResponse() });
    const { key, email } = await issueKey();
    await env.CACHE.put(`usage:${email}:${currentPeriod()}`, '250'); // free plan exhausted
    await env.CACHE.put(`topup:${email}`, '2');

    const r1 = await authedFetch(DATA_URL, key);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Credits-Source')).toBe('topup');
    expect(r1.headers.get('X-Credits-Remaining')).toBe('1');
    expect(r1.headers.get('X-Upgrade-Nudge')).toBeNull();

    const r2 = await authedFetch(DATA_URL, key);
    expect(r2.headers.get('X-Credits-Remaining')).toBe('0');

    const blocked = await authedFetch(DATA_URL, key);
    expect(blocked.status).toBe(402);
    const err = (await blocked.json()) as ErrorEnvelope;
    expect(err.error.code).toBe('quota_exceeded');
    expect(err.error.message).toContain('credit pack');
    expect(await usage(key)).toMatchObject({ used: 250, remaining: 0, topup: 0 });
  });

  it('leaves the plan path untouched while the allowance lasts', async () => {
    stubOrigins({ planning: () => planningResponse() });
    const { key, email } = await issueKey();
    await env.CACHE.put(`topup:${email}`, '5');
    const res = await authedFetch(DATA_URL, key);
    expect(res.headers.get('X-Credits-Source')).toBe('plan');
    expect(res.headers.get('X-Credits-Remaining')).toBe('249');
    expect(await usage(key)).toMatchObject({ used: 1, remaining: 254, topup: 5, alerts: [] });
  });
});

describe('MCP buy_credits / confirm_credit_purchase', () => {
  interface Rpc {
    result?: {
      tools?: { name: string }[];
      structuredContent?: { ok?: boolean; data?: Record<string, unknown> };
      content?: { text: string }[];
      isError?: boolean;
    };
  }
  async function rpc(
    key: string | null,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Rpc | null }> {
    const res = await SELF.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        ...(key === null ? {} : bearer(key)),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      const line = (await res.text()).split('\n').find((l) => l.startsWith('data:'));
      return { status: res.status, body: line ? (JSON.parse(line.slice(5)) as Rpc) : null };
    }
    if (type.includes('application/json'))
      return { status: res.status, body: (await res.json()) as Rpc };
    return { status: res.status, body: null };
  }

  it('lists both tools; a keyless buy_credits gets the sign-in 401', async () => {
    const list = await rpc(null, 'tools/list');
    const names = (list.body?.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['buy_credits', 'confirm_credit_purchase']));
    const anon = await rpc(null, 'tools/call', {
      name: 'buy_credits',
      arguments: { pack: 'pack_1k' },
    });
    expect(anon.status).toBe(401);
  });

  it('buys, confirms and reports the balance through the tools', async () => {
    stubPayPal();
    const { key } = await issueKey();
    const bought = await rpc(key, 'tools/call', {
      name: 'buy_credits',
      arguments: { pack: 'pack_5k' },
    });
    expect(bought.status).toBe(200);
    const order = bought.body?.result?.structuredContent?.data as Record<string, unknown>;
    expect(order).toMatchObject({
      order_id: 'ORDER1',
      approve_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
      credits: 5000,
      amount_usd: '35.00',
    });
    expect(String(order.next)).toContain('confirm_credit_purchase');

    const confirmed = await rpc(key, 'tools/call', {
      name: 'confirm_credit_purchase',
      arguments: { order_id: 'ORDER1' },
    });
    expect(confirmed.body?.result?.structuredContent?.data).toMatchObject({
      status: 'completed',
      credits_added: 5000,
      topup: 5000,
    });

    const usageTool = await rpc(key, 'tools/call', { name: 'get_usage', arguments: {} });
    expect(usageTool.body?.result?.structuredContent?.data).toMatchObject({
      granted: 250,
      remaining: 5250,
      topup: 5000,
    });

    const replay = await rpc(key, 'tools/call', {
      name: 'confirm_credit_purchase',
      arguments: { order_id: 'ORDER1' },
    });
    expect(replay.body?.result?.structuredContent?.data).toMatchObject({
      status: 'already_completed',
      credits_added: 0,
    });
    const stranger = await issueKey();
    const denied = await rpc(stranger.key, 'tools/call', {
      name: 'confirm_credit_purchase',
      arguments: { order_id: 'ORDER1' },
    });
    expect(denied.body?.result?.isError).toBe(true);
  });
});
