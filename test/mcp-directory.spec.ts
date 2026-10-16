import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREVIEW_CALLS_PER_DAY, PREVIEW_ROWS } from '../src/mcp/preview';
import { PROTECTED_TOOLS } from '../src/mcp/server';
import { listSources } from '../src/sources/registry';
import { bearer, issueKey } from './helpers/auth';

// Conformance test for agent-directory listings (Claude Connectors Directory
// first; the same rules cover ChatGPT and Cursor): every tool carries a title
// and read-only/destructive hints, names fit 64 chars, a foreign Origin is
// refused, and every tool answers successfully WITHOUT a key — the keyless
// preview — because an authless listing cannot carry one.

const MCP_URL = 'https://example.com/mcp';

interface Tool {
  name: string;
  title?: string;
  description?: string;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
}

interface RpcResponse {
  result?: {
    tools?: Tool[];
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: RpcResponse | null; res: Response }> {
  const res = await SELF.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'CF-Connecting-IP': '203.0.113.9',
      'User-Agent': 'directory-conformance-test',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    return {
      status: res.status,
      body: dataLine ? (JSON.parse(dataLine.slice(5)) as RpcResponse) : null,
      res,
    };
  }
  if (contentType.includes('application/json')) {
    return { status: res.status, body: (await res.json()) as RpcResponse, res };
  }
  return { status: res.status, body: null, res };
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<RpcResponse['result']> {
  const { status, body } = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    headers,
  );
  expect(status).toBe(200);
  return body?.result;
}

/** Every dataset loaded and empty: a KV snapshot or a D1 generation with no rows. */
async function seedEmptyDatasets(): Promise<void> {
  const now = new Date().toISOString();
  for (const source of listSources()) {
    if (source.storage === 'd1') {
      await env.DB.prepare(
        `INSERT INTO source_meta (source_slug, generation, last_refreshed_at, total) VALUES (?1, 1, ?2, 0)
         ON CONFLICT (source_slug) DO UPDATE SET generation = 1, last_refreshed_at = ?2, total = 0`,
      )
        .bind(source.slug, now)
        .run();
    } else {
      await env.CACHE.put(
        `data:${source.slug}`,
        JSON.stringify({ records: [], last_refreshed_at: now }),
      );
    }
  }
}

function stubResend(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://api.resend.com/'))
        return Promise.resolve(Response.json({ id: 'email_1' }));
      throw new Error(`unexpected outbound fetch in test: ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/mcp directory conformance', () => {
  it('lists every tool with a title, read-only/destructive hints and a name ≤ 64 chars', async () => {
    const { body } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const tools = body?.result?.tools ?? [];
    expect(tools.length).toBeGreaterThanOrEqual(listSources().length + 5);
    for (const tool of tools) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
      expect(tool.title ?? tool.annotations?.title, tool.name).toBeTruthy();
      expect(tool.description, tool.name).toBeTruthy();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
    }
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual(
      expect.arrayContaining(['list_sources', 'get_usage', 'get_changes', 'query_uk_tenders']),
    );
    // The sign-up pair and the credit-purchase pair (PayPal sandbox, 2026-10-11) are the
    // only writes; none destroys anything.
    const writes = tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name);
    expect(writes.sort()).toEqual([
      'buy_credits',
      'claim_api_key',
      'confirm_credit_purchase',
      'request_api_key',
    ]);
    expect(tools.some((t) => t.annotations?.destructiveHint)).toBe(false);
  });

  it('refuses a foreign Origin with 403 and accepts Claude, own and loopback origins', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const foreign = await post(list, { Origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.res.headers.get('access-control-allow-origin')).toBeNull();
    expect((await post(list, { Origin: 'http://gankdat.com' })).status).toBe(403);
    for (const origin of [
      'https://claude.ai',
      'https://gankdat.com',
      'http://localhost:6274',
      'http://127.0.0.1:8787',
    ]) {
      const ok = await post(list, { Origin: origin });
      expect(ok.status, origin).toBe(200);
      expect(ok.res.headers.get('access-control-allow-origin'), origin).toBe(origin);
    }
    expect((await post(list)).status).toBe(200);
  });

  it('answers every tool successfully without a key (the preview)', async () => {
    await seedEmptyDatasets();
    stubResend();

    const { body } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = (body?.result?.tools ?? []).map((t) => t.name);
    const feed = listSources().find((s) => s.idOf)?.slug;
    expect(feed).toBeTruthy();

    const signup = await call('request_api_key', { email: 'preview@example.com' });
    expect(signup?.isError, 'request_api_key').toBeFalsy();
    const req = (
      signup?.structuredContent as { data: { request_id: string; claim_secret: string } }
    ).data;

    for (const name of names) {
      let args: Record<string, unknown> = {};
      if (name === 'request_api_key') continue;
      if (PROTECTED_TOOLS.has(name)) {
        // The deliberately protected tools (connect_account and the two credit-purchase
        // tools): a transport-level 401 with the OAuth challenge is the sanctioned
        // lazy-auth answer (oauth.spec.ts) — a purchase needs the user's account.
        const { status, res } = await post({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: {} },
        });
        expect(status).toBe(401);
        expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
        continue;
      }
      if (name === 'claim_api_key')
        args = { request_id: req.request_id, claim_secret: req.claim_secret };
      if (name === 'get_changes') args = { source: feed };
      // A lookup tool needs its key; the origin is offline here, so the bundled sample answers.
      const lookup = listSources().find(
        (s) => `query_${s.slug.replaceAll('-', '_')}` === name && s.lookup,
      )?.lookup;
      if (lookup) args = { ...lookup.example };
      const result = await call(name, args);
      expect(result?.isError, `${name}: ${result?.content?.[0]?.text ?? ''}`).toBeFalsy();
      expect((result?.structuredContent as { ok: boolean }).ok, name).toBe(true);
    }
  });

  it('treats a bare Bearer header (a client whose key secret is unset) as no key', async () => {
    await seedEmptyDatasets();
    // Docker's MCP gateway sends `Authorization: Bearer ${GANKDAT_API_KEY}` for every
    // Toolkit user and leaves the variable empty until a key is pasted (mcp-gateway
    // pkg/mcp/remote.go): that user is keyless and gets the preview, not a 401.
    const bare = { Authorization: 'Bearer' };
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, bare);
    expect(list.status).toBe(200);
    const slug = listSources().find((s) => !s.lookup)?.slug;
    expect(slug).toBeTruthy();
    const tool = `query_${slug!.replaceAll('-', '_')}`;
    const result = await call(tool, {}, bare);
    expect(result?.isError, result?.content?.[0]?.text ?? '').toBeFalsy();
    expect((result?.structuredContent as { ok: boolean }).ok).toBe(true);
    // Anything after the scheme is still a presented key and 401s loudly.
    const { status } = await post(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } },
      { Authorization: 'Bearer not-a-key' },
    );
    expect(status).toBe(401);
  });

  it('caps the preview at PREVIEW_ROWS rows and names the plans once the daily budget is spent', async () => {
    await seedEmptyDatasets();
    const client = { 'CF-Connecting-IP': '198.51.100.77', 'User-Agent': 'budget-test' };

    const first = await call('query_uk_tenders', { per_page: 50, page: 3 }, client);
    const meta = (first?.structuredContent as { meta: Record<string, unknown> }).meta;
    expect(meta.per_page).toBe(PREVIEW_ROWS);
    expect(meta.page).toBe(1);
    expect(meta.credits_remaining).toBeUndefined();
    const preview = meta.preview as { calls_remaining_today: number; next: string };
    expect(preview.calls_remaining_today).toBe(PREVIEW_CALLS_PER_DAY - 1);
    expect(preview.next).toContain('request_api_key');

    // Spend the rest of the day's budget (get_usage is free and reads the count).
    for (let i = 1; i < PREVIEW_CALLS_PER_DAY; i += 1) {
      const r = await call('query_uk_tenders', {}, client);
      expect(r?.isError, `call ${i}`).toBeFalsy();
    }
    const usage = await call('get_usage', {}, client);
    expect(
      (usage?.structuredContent as { data: { preview: { calls_remaining_today: number } } }).data
        .preview.calls_remaining_today,
    ).toBe(0);

    // Spent: the HTTP-level OAuth challenge (what makes Claude show its
    // Connect card), with the plan text as the advisory description.
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');
    const over = await post(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'query_uk_tenders', arguments: {} },
      },
      client,
    );
    expect(over.status).toBe(401);
    expect(over.res.headers.get('www-authenticate')).toContain('resource_metadata=');
    const overBody = over.body as unknown as { error: string; error_description: string };
    expect(overBody.error).toBe('invalid_token');
    expect(overBody.error_description).toContain('Preview limit reached');
    expect(overBody.error_description).toContain('£5/month');
    expect(overBody.error_description).toContain('250 credits/month');
    // Every way on, in the order an agent can act (preview-wall-next-steps): pay per call,
    // the free key through the chat, a person's sign-in — in the body and the header line.
    expect(overBody.error_description).toContain('/x402/data/<source>');
    expect(overBody.error_description).toContain('request_api_key');
    expect(overBody.error_description).toContain('connect_account');
    expect(over.res.headers.get('www-authenticate')).toContain('request_api_key');
    expect(over.res.headers.get('www-authenticate')).toContain('/x402/data/');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: [
          'mcp_denied',
          'budget-test',
          'tools/call',
          'preview_exhausted',
          'query_uk_tenders',
          expect.stringMatching(/^[0-9a-f]{16}$/),
        ],
      }),
    );
    spy.mockRestore();

    // Another client has its own budget; a key is never previewed.
    const other = await call('query_uk_tenders', {}, { ...client, 'User-Agent': 'other-agent' });
    expect(other?.isError).toBeFalsy();
    const { key } = await issueKey();
    const keyed = await call(
      'query_uk_tenders',
      { per_page: 50 },
      { ...client, ...(bearer(key) as Record<string, string>) },
    );
    const keyedMeta = (keyed?.structuredContent as { meta: Record<string, unknown> }).meta;
    expect(keyedMeta.per_page).toBe(50);
    expect(keyedMeta.credits_remaining).toBe(249);
    expect(keyedMeta.preview).toBeUndefined();
  });
});
