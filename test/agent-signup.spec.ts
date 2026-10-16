import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPROVE_TTL_MS, CLAIM_TTL_MS } from '../src/auth/signup';

// Agent-side sign-up (build routine 2026-09-25): an agent at the paywall asks
// for a key with the user's email, the user approves one emailed link, the
// agent collects the key with its claim secret. REST and MCP share one module.

const BASE = 'https://example.com';
const MCP_URL = `${BASE}/mcp`;

interface SentEmail {
  to: string[];
  subject: string;
  text: string;
}
const sent: SentEmail[] = [];

function stubResend(ok = true): void {
  sent.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.resend.com/')) {
        sent.push(JSON.parse(String(init?.body)) as SentEmail);
        return Promise.resolve(
          ok
            ? Response.json({ id: 'email_1' })
            : Response.json({ statusCode: 403, name: 'validation_error' }, { status: 403 }),
        );
      }
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

function approveTokenFromEmail(mail: SentEmail): string {
  const match = /\/v1\/auth\/approve\?token=([0-9a-f]+)/.exec(mail.text);
  if (!match) throw new Error('no approval link in email');
  return match[1]!;
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

interface SignupData {
  request_id: string;
  claim_secret: string;
  code: string;
  email: string;
  approve_by: string;
}

async function requestViaRest(email: string, ip = '203.0.113.9'): Promise<SignupData> {
  const res = await post(
    '/v1/auth/agent-signup',
    { email, client_name: 'test-agent' },
    { 'CF-Connecting-IP': ip },
  );
  expect(res.status).toBe(202);
  const body = (await res.json()) as { ok: true; data: SignupData };
  return body.data;
}

/** The human's click: same-origin POST of the token, as the confirm page submits it. */
async function approve(token: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/auth/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: `token=${token}`,
  });
}

async function claimViaRest(request_id: string, claim_secret: string) {
  const res = await post('/v1/auth/agent-signup/claim', { request_id, claim_secret });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface RpcResponse {
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function rpc(
  key: string | null,
  method: string,
  params: Record<string, unknown> = {},
  ip = '198.51.100.7',
): Promise<{ status: number; body: RpcResponse | null }> {
  const res = await SELF.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      ...(key === null ? {} : { Authorization: `Bearer ${key}` }),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    return {
      status: res.status,
      body: dataLine ? (JSON.parse(dataLine.slice(5)) as RpcResponse) : null,
    };
  }
  if (contentType.includes('application/json')) {
    return { status: res.status, body: (await res.json()) as RpcResponse };
  }
  return { status: res.status, body: null };
}

describe('agent sign-up over REST', () => {
  it('emails the user a code + approval link and hands the agent a claim secret', async () => {
    stubResend();
    const data = await requestViaRest('Agent.User+tag@Example.com');
    expect(data.email).toBe('agent.user@example.com'); // normalized identity
    expect(data.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.claim_secret).toMatch(/^fsig_[0-9a-f]{64}$/);
    expect(data.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['agent.user@example.com']);
    expect(sent[0]!.subject).toContain(data.code);
    expect(sent[0]!.text).toContain('test-agent');
    // The approval token is only in the email — never handed to the agent.
    expect(JSON.stringify(data)).not.toContain(approveTokenFromEmail(sent[0]!));
  });

  it('reports pending until the human approves, then issues a working key exactly once', async () => {
    stubResend();
    const data = await requestViaRest('claimer@example.com');
    const token = approveTokenFromEmail(sent[0]!);

    const pending = await claimViaRest(data.request_id, data.claim_secret);
    expect(pending.status).toBe(200);
    expect((pending.body.data as { status: string }).status).toBe('pending');

    // GET renders the approval page (code visible) without consuming anything.
    const page = await SELF.fetch(`${BASE}/v1/auth/approve?token=${token}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(data.code);
    expect(html).toContain('claimer@example.com');
    const stillPending = await claimViaRest(data.request_id, data.claim_secret);
    expect((stillPending.body.data as { status: string }).status).toBe('pending');

    const approved = await approve(token);
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain('approved');

    const claim = await claimViaRest(data.request_id, data.claim_secret);
    expect(claim.status).toBe(200);
    const issued = claim.body.data as { status: string; api_key: string; plan: string };
    expect(issued.status).toBe('approved');
    expect(issued.api_key).toMatch(/^fapi_/);
    expect(issued.plan).toBe('free');

    // The key authenticates like any dashboard-made key, under the account.
    const usage = await SELF.fetch(`${BASE}/v1/usage`, {
      headers: { Authorization: `Bearer ${issued.api_key}` },
    });
    expect(usage.status).toBe(200);
    const keyRow = await env.DB.prepare('SELECT name, account_id FROM api_keys WHERE id = ?1')
      .bind((claim.body.data as { key_id: string }).key_id)
      .first<{ name: string; account_id: string }>();
    expect(keyRow?.name).toBe('agent:test-agent');
    const acct = await env.DB.prepare('SELECT id FROM accounts WHERE email = ?1')
      .bind('claimer@example.com')
      .first<{ id: string }>();
    expect(keyRow?.account_id).toBe(acct?.id);

    // Second claim: gone. Second approval click: link expired.
    const again = await claimViaRest(data.request_id, data.claim_secret);
    expect(again.status).toBe(410);
    expect((await approve(token)).status).toBe(410);
  });

  it('rejects a wrong claim secret, a cross-site approval POST and an expired link', async () => {
    stubResend();
    const data = await requestViaRest('strict@example.com');
    const token = approveTokenFromEmail(sent[0]!);

    const wrong = await claimViaRest(data.request_id, 'fsig_' + '0'.repeat(64));
    expect(wrong.status).toBe(404);

    // A cross-site form post (login-CSRF shape) never approves.
    const csrf = await approve(token, { 'Sec-Fetch-Site': 'cross-site' });
    expect(csrf.status).toBe(403);
    expect((await claimViaRest(data.request_id, data.claim_secret)).status).toBe(200);

    // Past the approval deadline the link is dead and the claim reports expired.
    await env.DB.prepare('UPDATE agent_signups SET expires_at = ?2 WHERE id = ?1')
      .bind(data.request_id, Date.now() - APPROVE_TTL_MS)
      .run();
    expect((await SELF.fetch(`${BASE}/v1/auth/approve?token=${token}`)).status).toBe(410);
    expect((await approve(token)).status).toBe(410);
    const expired = await claimViaRest(data.request_id, data.claim_secret);
    expect(expired.status).toBe(410);
  });

  it('lets an approved key lapse if not collected within the claim window', async () => {
    stubResend();
    const data = await requestViaRest('slow@example.com');
    await approve(approveTokenFromEmail(sent[0]!));
    await env.DB.prepare('UPDATE agent_signups SET approved_at = ?2 WHERE id = ?1')
      .bind(data.request_id, Date.now() - CLAIM_TTL_MS - 1000)
      .run();
    expect((await claimViaRest(data.request_id, data.claim_secret)).status).toBe(410);
  });

  it('caps requests per IP and emails per address, and does not promise an email the provider refused', async () => {
    stubResend();
    // Per-IP: the 6th request in the window is throttled (shared login-sized budget).
    for (let i = 0; i < 5; i += 1) await requestViaRest(`ip${i}@example.com`, '192.0.2.1');
    const sixth = await post(
      '/v1/auth/agent-signup',
      { email: 'ip6@example.com' },
      { 'CF-Connecting-IP': '192.0.2.1' },
    );
    expect(sixth.status).toBe(429);

    // Per-email: an attacker rotating IPs cannot bomb one inbox.
    for (let i = 0; i < 4; i += 1) await requestViaRest('victim@example.com', `192.0.2.${10 + i}`);
    const fifth = await post(
      '/v1/auth/agent-signup',
      { email: 'victim@example.com' },
      { 'CF-Connecting-IP': '192.0.2.99' },
    );
    expect(fifth.status).toBe(429);
    expect(sent.filter((m) => m.to[0] === 'victim@example.com')).toHaveLength(4);

    stubResend(false);
    const refused = await post(
      '/v1/auth/agent-signup',
      { email: 'refused@example.com' },
      { 'CF-Connecting-IP': '192.0.2.50' },
    );
    expect(refused.status).toBe(502);
  });

  it('inherits an existing paid plan — which is why the human, not the agent, approves', async () => {
    stubResend();
    await env.DB.prepare("INSERT INTO accounts (id, email, plan) VALUES (?1, ?2, 'growth')")
      .bind(crypto.randomUUID(), 'paid@example.com')
      .run();
    const data = await requestViaRest('paid@example.com');
    await approve(approveTokenFromEmail(sent[0]!));
    const claim = await claimViaRest(data.request_id, data.claim_secret);
    expect((claim.body.data as { plan: string }).plan).toBe('growth');
  });
});

describe('agent sign-up over MCP', () => {
  it('lists both sign-up tools anonymously and runs them without a key', async () => {
    stubResend();
    const list = await rpc(null, 'tools/list');
    const names = (list.body?.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['request_api_key', 'claim_api_key']));

    const req = await rpc(null, 'tools/call', {
      name: 'request_api_key',
      arguments: { email: 'mcp@example.com', client_name: 'Claude Desktop' },
    });
    expect(req.status).toBe(200);
    expect(req.body?.result?.isError).toBeFalsy();
    const data = (req.body?.result?.structuredContent as { data: SignupData }).data;
    expect(data.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(sent[0]!.text).toContain('Claude Desktop');

    const pending = await rpc(null, 'tools/call', {
      name: 'claim_api_key',
      arguments: { request_id: data.request_id, claim_secret: data.claim_secret },
    });
    expect(
      (pending.body?.result?.structuredContent as { data: { status: string } }).data.status,
    ).toBe('pending');

    await approve(approveTokenFromEmail(sent[0]!));
    const claim = await rpc(null, 'tools/call', {
      name: 'claim_api_key',
      arguments: { request_id: data.request_id, claim_secret: data.claim_secret },
    });
    const issued = (
      claim.body?.result?.structuredContent as { data: { status: string; api_key: string } }
    ).data;
    expect(issued.status).toBe('approved');
    expect(issued.api_key).toMatch(/^fapi_/);
    expect(
      await env.DB.prepare("SELECT name FROM api_keys WHERE name = 'agent:Claude Desktop'").first(),
    ).toBeTruthy();

    // The issued key drives a data tool.
    const usage = await rpc(issued.api_key, 'tools/call', { name: 'get_usage', arguments: {} });
    expect(usage.body?.result?.isError).toBeFalsy();
  });

  it('answers every other keyless tools/call as a preview that names the sign-up tool', async () => {
    const res = await rpc(null, 'tools/call', { name: 'get_usage', arguments: {} });
    expect(res.status).toBe(200);
    expect(res.body?.result?.isError).toBeFalsy();
    const data = (res.body?.result?.structuredContent as { data: { plan: string; next: string } })
      .data;
    expect(data.plan).toBe('preview');
    expect(data.next).toContain('request_api_key');
    // A batch that mixes a sign-up call with a data call rides the preview lane too.
    const mixed = await SELF.fetch(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'claim_api_key', arguments: {} },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'get_usage', arguments: {} },
        },
      ]),
    });
    expect(mixed.status).toBe(200);
  });

  it('throttles request_api_key per IP like login while claim polls stay cheap', async () => {
    stubResend();
    for (let i = 0; i < 5; i += 1) {
      const r = await rpc(
        null,
        'tools/call',
        { name: 'request_api_key', arguments: { email: `m${i}@example.com` } },
        '192.0.2.200',
      );
      expect(r.status).toBe(200);
    }
    const sixth = await rpc(
      null,
      'tools/call',
      { name: 'request_api_key', arguments: { email: 'm6@example.com' } },
      '192.0.2.200',
    );
    expect(sixth.status).toBe(429);
    // Polling from the same IP is not blocked by the sign-up budget.
    const poll = await rpc(
      null,
      'tools/call',
      { name: 'claim_api_key', arguments: { request_id: 'x', claim_secret: 'y' } },
      '192.0.2.200',
    );
    expect(poll.status).toBe(200);
    expect(poll.body?.result?.isError).toBe(true);
  });
});
