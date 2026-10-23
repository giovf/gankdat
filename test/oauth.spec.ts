import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCESS_TTL_SECONDS, OAUTH_SCOPE, pkceChallenge } from '../src/auth/oauth';
import { listSources } from '../src/sources/registry';

// Lazy OAuth for /mcp (auth/oauth.ts, routes/oauth.ts): the flow Claude, Cursor
// and ChatGPT run — 401 challenge → discovery → CIMD client → magic-link
// consent → PKCE code exchange → tokens that bill the account like a key →
// rotating refresh with replay detection.

// The worker under test answers at example.com but its PUBLIC_BASE_URL (the
// issuer, the resource, every URL it prints) is gankdat.com — as in production.
const BASE = 'https://example.com';
const PUBLIC = 'https://gankdat.com';
const MCP_URL = `${BASE}/mcp`;
const RESOURCE = `${PUBLIC}/mcp`;
// Claude's real hosted-apps client document (claude.com/docs/connectors/building/authentication,
// confirmed through the relay 2026-10-09); the Worker is generic — any CIMD URL works the same.
const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-abcdefghijklmnop';

const CLIENT_DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: 'Claude',
  redirect_uris: [CLAUDE_CALLBACK, 'http://localhost/callback', 'http://127.0.0.1/callback'],
};

/** Outbound stubs: the CIMD document and Resend. Everything else is a test bug. */
function stubOutbound(client: unknown = CLIENT_DOCUMENT): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === CLIENT_ID) {
      return Promise.resolve(
        client === null ? new Response('not found', { status: 404 }) : Response.json(client),
      );
    }
    if (url.startsWith('https://api.resend.com/'))
      return Promise.resolve(Response.json({ id: 'email_1' }));
    throw new Error(`unexpected outbound fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  stubOutbound();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

interface RpcResponse {
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
}

async function mcpCall(
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<{ status: number; res: Response; result?: RpcResponse['result'] }> {
  const res = await SELF.fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'CF-Connecting-IP': '203.0.113.42',
      'User-Agent': 'oauth-spec',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (res.status !== 200) return { status: res.status, res };
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    return {
      status: res.status,
      res,
      result: dataLine ? (JSON.parse(dataLine.slice(5)) as RpcResponse).result : undefined,
    };
  }
  return { status: res.status, res, result: ((await res.json()) as RpcResponse).result };
}

async function seedTenders(): Promise<void> {
  const source = listSources().find((s) => s.slug === 'uk-tenders')!;
  expect(source.storage).not.toBe('d1');
  await env.CACHE.put(
    'data:uk-tenders',
    JSON.stringify({ records: [], last_refreshed_at: new Date().toISOString() }),
  );
}

function authorizeUrl(overrides: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: CLAUDE_CALLBACK,
    state: 'xyz-123',
    scope: OAUTH_SCOPE,
    code_challenge: '',
    code_challenge_method: 'S256',
    resource: RESOURCE,
    ...overrides,
  };
  const url = new URL(`${BASE}/authorize`);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

async function startAuthorize(
  overrides: Record<string, string | null> = {},
  ip = '203.0.113.42', // /authorize is limited per IP in the isolate for the whole file
): Promise<{
  res: Response;
  html: string;
  requestId: string | null;
}> {
  const res = await SELF.fetch(
    authorizeUrl({ code_challenge: await pkceChallenge(VERIFIER), ...overrides }),
    { redirect: 'manual', headers: { 'CF-Connecting-IP': ip } },
  );
  const html = res.headers.get('content-type')?.includes('text/html') ? await res.text() : '';
  const requestId = /name="request" value="([a-f0-9]{32})"/.exec(html)?.[1] ?? null;
  return { res, html, requestId };
}

const FORM = {
  'content-type': 'application/x-www-form-urlencoded',
  'Sec-Fetch-Site': 'same-origin',
  'CF-Connecting-IP': '203.0.113.42',
};

/** Sign in through the magic link with `next` and return the session cookie. */
async function signInViaMagicLink(requestId: string, email: string): Promise<string> {
  const login = await SELF.fetch(`${BASE}/authorize/login`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ request: requestId, email }).toString(),
  });
  expect(login.status).toBe(200);
  expect(await login.text()).toContain('Check your email');
  const row = await env.DB.prepare(
    'SELECT token FROM magic_tokens ORDER BY expires_at DESC LIMIT 1',
  ).first<{ token: string }>();
  const next = `/authorize?request=${requestId}`;
  const confirm = await SELF.fetch(
    `${BASE}/v1/auth/verify?token=${row!.token}&next=${encodeURIComponent(next)}`,
  );
  expect(confirm.status).toBe(200);
  expect(await confirm.text()).toContain(`name="next" value="${next.replace('?', '?')}"`);
  const verify = await SELF.fetch(`${BASE}/v1/auth/verify`, {
    method: 'POST',
    headers: FORM,
    body: new URLSearchParams({ token: row!.token, next }).toString(),
    redirect: 'manual',
  });
  expect(verify.status).toBe(302);
  expect(verify.headers.get('location')).toBe(`${PUBLIC}${next}`);
  const m = /fapi_session=([^;]+)/.exec(verify.headers.get('set-cookie') ?? '');
  expect(m).toBeTruthy();
  return `fapi_session=${m![1]}`;
}

async function approve(requestId: string, cookie: string): Promise<URL> {
  const res = await SELF.fetch(`${BASE}/authorize/decision`, {
    method: 'POST',
    headers: { ...FORM, Cookie: cookie },
    body: new URLSearchParams({ request: requestId, decision: 'approve' }).toString(),
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

interface TokenBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function token(params: Record<string, string>): Promise<{ status: number; body: TokenBody }> {
  const res = await SELF.fetch(`${BASE}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': '203.0.113.42',
      'User-Agent': 'claude-user',
    },
    body: new URLSearchParams(params).toString(),
  });
  expect(res.headers.get('cache-control')).toBe('no-store');
  return { status: res.status, body: (await res.json()) as TokenBody };
}

/** The whole happy path up to a token response. */
async function connect(email = 'oauth-user@example.com'): Promise<{
  access: string;
  refresh: string;
  cookie: string;
  email: string;
}> {
  const { requestId } = await startAuthorize();
  expect(requestId).toBeTruthy();
  const cookie = await signInViaMagicLink(requestId!, email);
  const redirected = await approve(requestId!, cookie);
  const code = redirected.searchParams.get('code')!;
  const exchanged = await token({
    grant_type: 'authorization_code',
    code,
    code_verifier: VERIFIER,
    client_id: CLIENT_ID,
    redirect_uri: CLAUDE_CALLBACK,
  });
  expect(exchanged.status).toBe(200);
  return {
    access: exchanged.body.access_token!,
    refresh: exchanged.body.refresh_token!,
    cookie,
    email,
  };
}

describe('discovery', () => {
  it('serves the protected-resource documents (both paths) and the authorization-server metadata', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await SELF.fetch(`${BASE}${path}`, {
        headers: { Origin: 'https://inspector.example' },
      });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('access-control-allow-origin'), path).toBe('*');
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(RESOURCE);
      expect(doc.authorization_servers).toEqual([PUBLIC]);
      expect(doc.scopes_supported).toEqual([OAUTH_SCOPE]);
    }
    const as = await SELF.fetch(`${BASE}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const meta = (await as.json()) as Record<string, unknown>;
    expect(meta).toMatchObject({
      issuer: PUBLIC,
      authorization_endpoint: `${PUBLIC}/authorize`,
      token_endpoint: `${PUBLIC}/token`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      registration_endpoint: `${PUBLIC}/register`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });
});

// RFC 7591: Docker's MCP Toolkit, Cursor, ChatGPT and VS Code register a client
// instead of hosting a metadata document (only Claude does CIMD).
describe('/register (dynamic client registration)', () => {
  // The per-IP limiter lives in the isolate for the whole file: every registration gets its
  // own address so the tests do not spend each other's budget (10 a minute per IP).
  let nextIp = 1;
  async function register(
    body: unknown,
    ip = `198.51.100.${nextIp++}`,
  ): Promise<{ status: number; body: Record<string, unknown>; res: Response }> {
    const res = await SELF.fetch(`${BASE}/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'CF-Connecting-IP': ip,
        'User-Agent': 'docker-mcp-gateway',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, res };
  }

  it('rate-limits registrations per IP like /authorize', async () => {
    const ip = '198.51.100.250';
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await register({ redirect_uris: ['http://127.0.0.1/cb'] }, ip)).status;
    }
    expect(last).toBe(429);
  });

  it('issues a public client_id for a loopback native app and echoes the metadata', async () => {
    const { status, body, res } = await register({
      client_name: 'Docker MCP Toolkit',
      redirect_uris: ['http://127.0.0.1:8765/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.client_id).toMatch(/^gkcl_docker-mcp-toolkit_[a-f0-9]{32}$/);
    expect(body).toMatchObject({
      client_name: 'Docker MCP Toolkit',
      redirect_uris: ['http://127.0.0.1:8765/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: OAUTH_SCOPE,
    });
    expect(typeof body.client_id_issued_at).toBe('number');
    expect(body.client_secret).toBeUndefined();
    const row = await env.DB.prepare('SELECT client_name FROM oauth_clients WHERE client_id = ?1')
      .bind(body.client_id)
      .first<{ client_name: string }>();
    expect(row?.client_name).toBe('Docker MCP Toolkit');
  });

  it('labels an https client by its redirect host, never by a name that claims one', async () => {
    const hosted = await register({
      client_name: 'claude.ai',
      redirect_uris: ['https://app.example.org/oauth/cb', 'http://localhost/cb'],
    });
    expect(hosted.status).toBe(201);
    expect(hosted.body.client_id).toMatch(/^gkcl_app\.example\.org_/);
    const nameOnly = await register({
      client_name: 'claude.ai',
      redirect_uris: ['http://localhost/cb'],
    });
    expect(nameOnly.body.client_id).toMatch(/^gkcl_claude-ai_/);
    const nameless = await register({ redirect_uris: ['http://[::1]:9/cb'] });
    expect(nameless.body.client_id).toMatch(/^gkcl_local-app_/);
    expect(nameless.body.client_name).toBeUndefined();
  });

  it('rejects confidential clients, bad redirect URIs, foreign grants and non-JSON with RFC 7591 errors', async () => {
    const cases: [unknown, string][] = [
      [{ redirect_uris: [] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['http://evil.example/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://10.0.0.1/cb'] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['https://ok.example/cb#frag'] }, 'invalid_redirect_uri'],
      [
        {
          redirect_uris: ['https://ok.example/cb'],
          token_endpoint_auth_method: 'client_secret_basic',
        },
        'invalid_client_metadata',
      ],
      [
        { redirect_uris: ['https://ok.example/cb'], grant_types: ['implicit'] },
        'invalid_client_metadata',
      ],
      [
        { redirect_uris: ['https://ok.example/cb'], response_types: ['token'] },
        'invalid_client_metadata',
      ],
      ['not json', 'invalid_client_metadata'],
      [[], 'invalid_client_metadata'],
    ];
    for (const [input, error] of cases) {
      const { status, body } = await register(input);
      expect(status, JSON.stringify(input)).toBe(400);
      expect(body.error, JSON.stringify(input)).toBe(error);
      expect(typeof body.error_description).toBe('string');
    }
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_clients').first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it('runs the whole flow for a registered client: consent names the label, the key is oauth:<label>', async () => {
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');
    const registered = await register({
      client_name: 'Docker MCP Toolkit',
      redirect_uris: ['http://127.0.0.1/callback'],
    });
    const clientId = registered.body.client_id as string;
    const redirectUri = 'http://127.0.0.1:51234/callback';
    const { res, html, requestId } = await startAuthorize(
      { client_id: clientId, redirect_uri: redirectUri },
      '198.51.100.99',
    );
    expect(res.status).toBe(200);
    expect(html).toContain('Connect gankdat to docker-mcp-toolkit');
    expect(requestId).toBeTruthy();
    const cookie = await signInViaMagicLink(requestId!, 'toolkit-user@example.com');
    const consent = await SELF.fetch(`${BASE}/authorize?request=${requestId}`, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '198.51.100.99' },
    });
    const consentHtml = await consent.text();
    expect(consentHtml).toContain('registered itself with gankdat');
    expect(consentHtml).toContain('oauth:docker-mcp-toolkit');
    const redirected = await approve(requestId!, cookie);
    expect(redirected.origin).toBe('http://127.0.0.1:51234');
    const exchanged = await token({
      grant_type: 'authorization_code',
      code: redirected.searchParams.get('code')!,
      code_verifier: VERIFIER,
      client_id: clientId,
      redirect_uri: redirectUri,
    });
    expect(exchanged.status).toBe(200);
    expect(exchanged.body.access_token).toMatch(/^gkat_/);
    const key = await env.DB.prepare(
      "SELECT name FROM api_keys WHERE email = ?1 AND name LIKE 'oauth:%'",
    )
      .bind('toolkit-user@example.com')
      .first<{ name: string }>();
    expect(key?.name).toBe('oauth:docker-mcp-toolkit');
    const call = await mcpCall(
      'connect_account',
      {},
      { Authorization: `Bearer ${exchanged.body.access_token}` },
    );
    expect(call.status).toBe(200);
    const steps = spy.mock.calls
      .map((call) => (call[0] as { blobs: string[] }).blobs)
      .filter((blobs) => blobs[0] === 'oauth_funnel')
      .map((blobs) => [blobs[2], blobs[3]]);
    expect(steps[0]).toEqual(['registered', 'docker-mcp-toolkit']);
    expect(steps).toContainEqual(['token', 'docker-mcp-toolkit']);
    spy.mockRestore();
  });

  it('refuses an unknown or malformed registered client_id with a page, never a redirect', async () => {
    const unknown = await startAuthorize(
      { client_id: `gkcl_nobody_${'0'.repeat(32)}`, redirect_uri: 'http://127.0.0.1/cb' },
      '198.51.100.98',
    );
    expect(unknown.res.status).toBe(400);
    expect(unknown.html).toContain('Unknown client');
    const malformed = await startAuthorize(
      { client_id: 'gkcl_', redirect_uri: 'http://127.0.0.1/cb' },
      '198.51.100.98',
    );
    expect(malformed.res.status).toBe(400);
    const registered = await register({ redirect_uris: ['https://app.example.org/cb'] });
    const wrongRedirect = await startAuthorize(
      { client_id: registered.body.client_id as string, redirect_uri: 'https://evil.example/cb' },
      '198.51.100.98',
    );
    expect(wrongRedirect.res.status).toBe(400);
    expect(wrongRedirect.html).toContain('Redirect not allowed');
  });
});

describe('the 401 gate on /mcp', () => {
  it('refuses a keyless call to connect_account at the HTTP layer with the resource_metadata challenge', async () => {
    const { status, res } = await mcpCall('connect_account');
    expect(status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer error="invalid_token"');
    expect(challenge).toContain(
      `resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain(`scope="${OAUTH_SCOPE}"`);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('turns a spent preview budget into the challenge instead of a 200 tool error', async () => {
    await seedTenders();
    const client = { 'CF-Connecting-IP': '198.51.100.9', 'User-Agent': 'spent-budget' };
    await env.RATE.put(
      `preview:${await previewId('198.51.100.9', 'spent-budget')}:${new Date().toISOString().slice(0, 10)}`,
      '20',
    );
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');
    const { status, res } = await mcpCall('query_uk_tenders', {}, client);
    expect(status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
    const body = (await res.json()) as { error_description: string };
    expect(body.error_description).toContain('Preview limit reached');
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        blobs: [
          'mcp_denied',
          'spent-budget',
          'tools/call',
          'preview_exhausted',
          'query_uk_tenders',
          await previewId('198.51.100.9', 'spent-budget'),
        ],
      }),
    );
    spy.mockRestore();
  });

  it('points an expired or unknown access token at the metadata too (so Claude refreshes)', async () => {
    const { status, res } = await mcpCall(
      'query_uk_tenders',
      {},
      { Authorization: 'Bearer gkat_nope' },
    );
    expect(status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});

async function previewId(ip: string, ua: string): Promise<string> {
  const { previewClientId } = await import('../src/mcp/preview');
  return previewClientId(ip, ua);
}

describe('/authorize', () => {
  it('never redirects to an unverified client: a missing CIMD document is a 400 page', async () => {
    stubOutbound(null);
    const { res, html } = await startAuthorize();
    expect(res.status).toBe(400);
    expect(html).toContain('Unknown client');
  });

  it('rejects a document whose client_id does not equal its URL', async () => {
    stubOutbound({ ...CLIENT_DOCUMENT, client_id: 'https://evil.example/client.json' });
    const { res } = await startAuthorize();
    expect(res.status).toBe(400);
  });

  it('rejects an unregistered redirect_uri with a page, not a redirect', async () => {
    const { res, html } = await startAuthorize({ redirect_uri: 'https://evil.example/cb' });
    expect(res.status).toBe(400);
    expect(html).toContain('Redirect not allowed');
  });

  it('accepts a loopback redirect on any port (Claude Code) and warns on consent', async () => {
    const { res, html, requestId } = await startAuthorize({
      redirect_uri: 'http://localhost:3118/callback',
    });
    expect(res.status).toBe(200);
    expect(html).toContain('Connect gankdat to claude.ai');
    expect(requestId).toBeTruthy();
    const cookie = await signInViaMagicLink(requestId!, 'code-user@example.com');
    const consent = await SELF.fetch(`${BASE}/authorize?request=${requestId}`, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.42' },
    });
    const consentHtml = await consent.text();
    expect(consentHtml).toContain('localhost:3118');
    expect(consentHtml).toContain('local address on this computer');
    expect(consentHtml).toContain('oauth:claude.ai');
    const redirected = await approve(requestId!, cookie);
    expect(redirected.origin).toBe('http://localhost:3118');
    expect(redirected.searchParams.get('code')).toMatch(/^gkac_/);
    expect(redirected.searchParams.get('state')).toBe('xyz-123');
  });

  it('redirects protocol errors to the verified redirect_uri with state', async () => {
    const missing = await startAuthorize({ code_challenge: null });
    expect(missing.res.status).toBe(302);
    const loc = new URL(missing.res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(CLAUDE_CALLBACK);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('xyz-123');

    const plain = await startAuthorize({ code_challenge_method: 'plain' });
    expect(new URL(plain.res.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_request',
    );
    const scope = await startAuthorize({ scope: 'admin' });
    expect(new URL(scope.res.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_scope',
    );
    const target = await startAuthorize({ resource: 'https://other.example/mcp' });
    expect(new URL(target.res.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_target',
    );
  });

  it('accepts every canonical spelling of its own resource and refuses any other host or path', async () => {
    // MCP authorization spec: https://mcp.example.com/mcp, https://mcp.example.com and the port form
    // are valid for one server; upper-case scheme and host SHOULD be accepted; the trailing slash is
    // only discouraged. The two /authorize calls of 10-20..10-23 were refused on a string compare.
    // Own IPs: /authorize is limited per IP for the whole file.
    let ip = 0;
    for (const resource of [
      `${PUBLIC}`,
      `${PUBLIC}/`,
      `${PUBLIC}/mcp/`,
      'HTTPS://GANKDAT.COM/mcp',
      'https://gankdat.com:443/mcp',
    ]) {
      const ok = await startAuthorize({ resource }, `198.51.100.${(ip += 1)}`);
      expect(ok.res.status, resource).toBe(200);
      expect(ok.requestId, resource).not.toBeNull();
    }
    for (const resource of [
      `${PUBLIC}/other`,
      `${PUBLIC}/mcp#frag`,
      `${PUBLIC}/mcp?x=1`,
      'http://gankdat.com/mcp',
      'https://gankdat.com:8443/mcp',
      'not a url',
    ]) {
      const bad = await startAuthorize({ resource }, `198.51.100.${(ip += 1)}`);
      expect(bad.res.status, resource).toBe(302);
      expect(new URL(bad.res.headers.get('location')!).searchParams.get('error'), resource).toBe(
        'invalid_target',
      );
    }
  });

  it('shows consent straight away for a signed-in browser and lets the user cancel', async () => {
    const first = await startAuthorize();
    const cookie = await signInViaMagicLink(first.requestId!, 'cancel@example.com');
    const second = await SELF.fetch(
      authorizeUrl({ code_challenge: await pkceChallenge(VERIFIER) }),
      {
        headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.42' },
      },
    );
    const html = await second.text();
    expect(html).toContain('approve and connect');
    expect(html).toContain('cancel@example.com');
    const requestId = /name="request" value="([a-f0-9]{32})"/.exec(html)![1]!;
    const denied = await SELF.fetch(`${BASE}/authorize/decision`, {
      method: 'POST',
      headers: { ...FORM, Cookie: cookie },
      body: new URLSearchParams({ request: requestId, decision: 'deny' }).toString(),
      redirect: 'manual',
    });
    expect(denied.status).toBe(302);
    const loc = new URL(denied.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('xyz-123');
    // A request is single use.
    const again = await SELF.fetch(`${BASE}/authorize?request=${requestId}`, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.42' },
    });
    expect(again.status).toBe(410);
  });

  it('serves the consent pages popup-safe: opener kept and the form may redirect to the client', async () => {
    const { requestId } = await startAuthorize();
    const res = await SELF.fetch(`${BASE}/authorize?request=${requestId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-opener-policy')).toBe('unsafe-none');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self' https:");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const api = await SELF.fetch(`${BASE}/v1/sources`);
    expect(api.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });

  it('answers a repeated approval by the same account with a fresh code (double-submitted form)', async () => {
    const { requestId } = await startAuthorize();
    const cookie = await signInViaMagicLink(requestId!, 'twice@example.com');
    const first = await approve(requestId!, cookie);
    const second = await approve(requestId!, cookie);
    expect(second.origin + second.pathname).toBe(first.origin + first.pathname);
    expect(second.searchParams.get('state')).toBe(first.searchParams.get('state'));
    expect(second.searchParams.get('code')).toBeTruthy();
    expect(second.searchParams.get('code')).not.toBe(first.searchParams.get('code'));
    const exchanged = await token({
      grant_type: 'authorization_code',
      code: second.searchParams.get('code')!,
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(exchanged.status).toBe(200);
    // A different account cannot ride the consumed request.
    const { requestId: otherRequest } = await startAuthorize();
    const other = await signInViaMagicLink(otherRequest!, 'someone-else@example.com');
    const res = await SELF.fetch(`${BASE}/authorize/decision`, {
      method: 'POST',
      headers: { ...FORM, Cookie: other },
      body: new URLSearchParams({ request: requestId!, decision: 'approve' }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(410);
  });

  it('refuses a cross-site decision POST and an approval without a session', async () => {
    const { requestId } = await startAuthorize();
    const crossSite = await SELF.fetch(`${BASE}/authorize/decision`, {
      method: 'POST',
      headers: { ...FORM, 'Sec-Fetch-Site': 'cross-site' },
      body: new URLSearchParams({ request: requestId!, decision: 'approve' }).toString(),
      redirect: 'manual',
    });
    expect(crossSite.status).toBe(403);
    const noSession = await SELF.fetch(`${BASE}/authorize/decision`, {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ request: requestId!, decision: 'approve' }).toString(),
      redirect: 'manual',
    });
    expect(noSession.status).toBe(401);
    expect(await noSession.text()).toContain('email me a sign-in link');
  });
});

describe('/token and the tokens it issues', () => {
  it('exchanges a code with PKCE for tokens that bill the account like a key', async () => {
    await seedTenders();
    const { access, email } = await connect();
    expect(access).toMatch(/^gkat_/);

    const data = await mcpCall(
      'query_uk_tenders',
      { per_page: 50 },
      { Authorization: `Bearer ${access}` },
    );
    expect(data.status).toBe(200);
    const meta = (data.result?.structuredContent as { meta: Record<string, unknown> }).meta;
    expect(meta.per_page).toBe(50);
    expect(meta.credits_remaining).toBe(249);
    expect(meta.preview).toBeUndefined();

    const connected = await mcpCall('connect_account', {}, { Authorization: `Bearer ${access}` });
    expect(connected.status).toBe(200);
    expect(connected.result?.structuredContent).toMatchObject({
      ok: true,
      data: { connected: true, account: email, plan: 'free', used: 1 },
    });

    // The connection is a named key on the account, visible at /account.
    const key = await env.DB.prepare(
      `SELECT k.name FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE a.email = ?1`,
    )
      .bind(email)
      .first<{ name: string }>();
    expect(key?.name).toBe('oauth:claude.ai');

    // The token also works on REST (same middleware).
    const rest = await SELF.fetch(`${BASE}/v1/usage`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    expect(rest.status).toBe(200);
  });

  it('answers the RFC 6749 shape: expires_in, Bearer, scope, and invalid_grant on a bad verifier or reused code', async () => {
    const { requestId } = await startAuthorize();
    const cookie = await signInViaMagicLink(requestId!, 'pkce@example.com');
    const code = (await approve(requestId!, cookie)).searchParams.get('code')!;

    const wrong = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-wrong-verifier',
      client_id: CLIENT_ID,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');

    // The code was consumed by the failed attempt: a replay revokes, still invalid_grant.
    const again = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');

    const fresh = await connect('shape@example.com');
    expect(fresh.access).toMatch(/^gkat_/);
    const res = await SELF.fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
  });

  it('rotates refresh tokens and revokes the family when an old one is replayed', async () => {
    await seedTenders();
    const { access, refresh } = await connect('refresh@example.com');
    const rotated = await token({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      scope: OAUTH_SCOPE,
    });
    expect(rotated.body.refresh_token).not.toBe(refresh);
    expect(rotated.body.access_token).not.toBe(access);
    const newAccess = rotated.body.access_token!;
    expect(
      (await mcpCall('list_sources', {}, { Authorization: `Bearer ${newAccess}` })).status,
    ).toBe(200);

    // Replay of the spent refresh token: invalid_grant, and every token of the family dies.
    const replay = await token({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
    });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    const next = await token({
      grant_type: 'refresh_token',
      refresh_token: rotated.body.refresh_token!,
      client_id: CLIENT_ID,
    });
    expect(next.status).toBe(400);
    expect(next.body.error).toBe('invalid_grant');
    // A fresh (never cached) token from the revoked family no longer authenticates.
    await env.CACHE.delete(`key:${await sha256(newAccess)}`);
    expect(
      (await mcpCall('list_sources', {}, { Authorization: `Bearer ${newAccess}` })).status,
    ).toBe(401);
  });

  it('revoking the oauth:<host> key at /account disconnects the client', async () => {
    const { access, refresh, cookie, email } = await connect('revoke@example.com');
    const account = await SELF.fetch(`${BASE}/v1/account`, { headers: { Cookie: cookie } });
    const keys = ((await account.json()) as { data: { keys: { id: string; name: string }[] } }).data
      .keys;
    const oauthKey = keys.find((k) => k.name === 'oauth:claude.ai');
    expect(oauthKey).toBeTruthy();
    const revoke = await SELF.fetch(`${BASE}/v1/account/keys/${oauthKey!.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(revoke.status).toBe(200);
    await env.CACHE.delete(`key:${await sha256(access)}`);
    expect((await mcpCall('list_sources', {}, { Authorization: `Bearer ${access}` })).status).toBe(
      401,
    );
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
    });
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe('invalid_grant');
    expect(email).toBe('revoke@example.com');
  });
});

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The connect funnel (gankdat oauth-connect-funnel-check, 2026-10-09): one `oauth_funnel`
// analytics point per leg, blob3 the step, blob4 the client host, blob5 the detail. The Daily
// numbers row reads them side by side (src/lib/oauth-funnel.ts), so an attempt that stops at
// the sign-in page is a number, not a guess.
describe('connect funnel points', () => {
  const funnelCalls = (spy: { mock: { calls: unknown[][] } }): string[][] =>
    spy.mock.calls
      .map((call) => (call[0] as { blobs: string[] }).blobs)
      .filter((blobs) => blobs[0] === 'oauth_funnel')
      .map((blobs) => blobs.slice(2));

  it('counts every leg of the happy path with the client host', async () => {
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');
    const { requestId } = await startAuthorize();
    const cookie = await signInViaMagicLink(requestId!, 'funnel@example.com');
    const consent = await SELF.fetch(`${BASE}/authorize?request=${requestId}`, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.42' },
    });
    expect(consent.status).toBe(200);
    const redirected = await approve(requestId!, cookie);
    const exchanged = await token({
      grant_type: 'authorization_code',
      code: redirected.searchParams.get('code')!,
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(exchanged.status).toBe(200);
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: exchanged.body.refresh_token!,
      client_id: CLIENT_ID,
    });
    expect(refreshed.status).toBe(200);
    expect(funnelCalls(spy)).toEqual([
      ['authorize', 'claude.ai', ''],
      ['signin_shown', 'claude.ai', 'new'],
      ['email_sent', 'claude.ai', 'sent'],
      ['consent_shown', 'claude.ai', 'continue'],
      ['approved', 'claude.ai', ''],
      ['token', 'claude.ai', 'authorization_code'],
      ['token', 'claude.ai', 'refresh_token'],
    ]);
    spy.mockRestore();
  });

  it('names the leg that rejected, denied, expired or refused', async () => {
    const spy = vi.spyOn(env.TRAFFIC, 'writeDataPoint');
    stubOutbound(null);
    await startAuthorize();
    stubOutbound();
    await startAuthorize({ redirect_uri: 'https://evil.example/cb' });
    await startAuthorize({ code_challenge_method: 'plain' });
    await startAuthorize({ resource: 'https://other.example/mcp' }, '198.51.100.99');
    await SELF.fetch(`${BASE}/authorize`, { headers: { 'CF-Connecting-IP': '203.0.113.42' } });
    await SELF.fetch(`${BASE}/authorize?request=${'0'.repeat(32)}`, {
      headers: { 'CF-Connecting-IP': '203.0.113.42' },
    });
    const { requestId } = await startAuthorize();
    const cookie = await signInViaMagicLink(requestId!, 'funnel-deny@example.com');
    const denied = await SELF.fetch(`${BASE}/authorize/decision`, {
      method: 'POST',
      headers: { ...FORM, Cookie: cookie },
      body: new URLSearchParams({ request: requestId!, decision: 'deny' }).toString(),
      redirect: 'manual',
    });
    expect(denied.status).toBe(302);
    const refused = await token({
      grant_type: 'authorization_code',
      code: 'gkac_nope',
      code_verifier: VERIFIER,
      client_id: CLIENT_ID,
    });
    expect(refused.status).toBe(400);
    expect(funnelCalls(spy)).toEqual([
      ['authorize_rejected', 'claude.ai', 'unknown_client'],
      ['authorize_rejected', 'claude.ai', 'redirect_not_allowed'],
      ['authorize_rejected', 'claude.ai', 'invalid_request: code_challenge_method must be S256'],
      ['authorize_rejected', 'claude.ai', 'invalid_target: https://other.example/mcp'],
      ['authorize_rejected', '', 'bad_query'],
      ['expired', '', 'authorize'],
      ['authorize', 'claude.ai', ''],
      ['signin_shown', 'claude.ai', 'new'],
      ['email_sent', 'claude.ai', 'sent'],
      ['denied', 'claude.ai', ''],
      ['token_rejected', 'claude.ai', 'invalid_grant: unknown or expired code'],
    ]);
    spy.mockRestore();
  });
});
