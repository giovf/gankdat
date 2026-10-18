import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireApiKey } from '../auth/middleware';
import { bearerChallenge, resourceMetadataUrl } from '../auth/oauth';
import { SIGNUP_RATE_LIMIT } from '../auth/signup';
import { API_BASE_URL, publicBaseUrl } from '../lib/constants';
import { failure } from '../lib/envelope';
import { previewCallsRemaining, previewClientId, previewExhaustedMessage } from '../mcp/preview';
import {
  buildMcpServer,
  FREE_TOOLS,
  MCP_NO_KEY_HINT,
  PROTECTED_TOOLS,
  SIGNUP_TOOLS,
} from '../mcp/server';
import { isolateRateLimit, rateLimit } from '../metering/ratelimit';
import type { AppEnv } from '../types';

// Stateless Streamable HTTP: Workers are stateless, so every request gets a
// fresh server + transport pair (no session ids). Tool execution uses the same
// bearer API key as REST; metering happens per tool call inside the handlers.
//
// POST only: a stateless server never pushes server-initiated notifications, so
// GET would just open a hanging SSE stream with a live keepalive timer, and
// DELETE (session teardown) is meaningless without sessions. Both 404 here.

// Methods a registry or directory crawler needs to index this server (the
// official MCP Registry's aggregators, Glama, Smithery all introspect tools by
// calling these). Metadata only — none touches an account or debits credits.
const INTROSPECTION_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
]);

// Origin validation (MCP Streamable HTTP transport security; a Connectors
// Directory check): a request that carries an Origin header must come from a
// browser context we expect — our own pages, Claude's, or a local MCP
// Inspector. Non-browser clients (Claude's connector runtime, Claude Code,
// Cursor, curl) send no Origin and are unaffected. Anything else is 403 before
// auth, so DNS-rebinding style calls from an arbitrary page never reach a tool.
const MCP_ORIGIN_HOSTS = new Set(['claude.ai', 'www.claude.ai', 'claude.com', 'www.claude.com']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function mcpOriginAllowed(origin: string, env: CloudflareBindings): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(url.host)) return true;
  if (url.protocol !== 'https:') return false;
  if (MCP_ORIGIN_HOSTS.has(url.hostname)) return true;
  for (const base of [API_BASE_URL, publicBaseUrl(env)]) {
    const own = new URL(base).hostname;
    if (url.hostname === own || url.hostname === `www.${own}`) return true;
  }
  return false;
}

// What an unauthenticated request may do. Anonymous only when NO key is
// presented — a presented key is always validated (a typo'd key should 401
// loudly, not silently downgrade to anonymous). 'introspection' is metadata
// only; 'signup' is the agent-side sign-up tools (request_api_key /
// claim_api_key — how a key is obtained); 'request' marks a message that
// sends an email and so gets the stricter KV-backed budget; 'preview' is any
// other tools/call without a key — the data tools answer a capped preview
// (mcp/preview.ts) so an authless directory listing can run every tool.
// Reading the body here is safe: HonoRequest caches parsed JSON, so the
// transport's own req.json() gets the cached copy, not a consumed stream.
// 'protected' is a tools/call on a tool that needs the user's account
// (mcp/server.ts PROTECTED_TOOLS): answered with the OAuth 401 below, which is
// what makes Claude show its Connect card (auth/oauth.ts).
type AnonymousKind = 'introspection' | 'signup' | 'request' | 'preview' | 'protected' | null;

/**
 * Whether an Authorization header carries a credential at all. Absent, empty
 * or a bare `Bearer` with no token is NO key: Docker's MCP gateway templates
 * `Authorization: Bearer ${GANKDAT_API_KEY}` for every Toolkit user and sends it
 * with the variable empty until a key is pasted (mcp-gateway pkg/mcp/remote.go),
 * so a bare scheme is a keyless user owed the preview, not a typo'd key. Anything
 * after the scheme is still validated and 401s loudly (2026-10-10).
 */
export function presentsCredential(header: string | undefined): boolean {
  return header !== undefined && !/^(?:Bearer)?\s*$/i.test(header);
}

async function anonymousKind(c: Context<AppEnv>): Promise<AnonymousKind> {
  if (presentsCredential(c.req.header('Authorization'))) return null;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return null; // malformed JSON: fall through to auth's 401
  }
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return null;
  let kind: AnonymousKind = 'introspection';
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) return null;
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
    if (typeof method !== 'string') return null;
    if (INTROSPECTION_METHODS.has(method)) continue;
    if (method === 'tools/call' && typeof params?.name === 'string') {
      if (PROTECTED_TOOLS.has(params.name)) return 'protected';
      if (FREE_TOOLS.has(params.name)) continue; // metadata-like: never gated
      if (params.name === 'request_api_key') kind = 'request';
      else if (SIGNUP_TOOLS.has(params.name)) {
        if (kind !== 'request') kind = 'signup';
      } else if (kind === 'introspection' || kind === 'signup') kind = 'preview';
      continue;
    }
    return null;
  }
  return kind;
}

// Comma-joined sorted unique JSON-RPC method names from the (possibly batched)
// body, recorded in analytics blobs. Same cached-parse safety note as
// isAnonymousIntrospection; '' when the body is malformed JSON.
/** JSON-RPC method(s) and, for tools/call, the tool name(s) — which dataset an agent wanted. */
async function requestShape(c: Context<AppEnv>): Promise<{ methods: string; tools: string }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { methods: '', tools: '' };
  }
  const messages = Array.isArray(body) ? body : [body];
  const methods = new Set<string>();
  const tools = new Set<string>();
  for (const message of messages) {
    const msg =
      typeof message === 'object' && message !== null
        ? (message as { method?: unknown; params?: { name?: unknown } })
        : {};
    methods.add(typeof msg.method === 'string' ? msg.method : '(invalid)');
    if (msg.method === 'tools/call' && typeof msg.params?.name === 'string') {
      tools.add(msg.params.name.slice(0, 64));
    }
  }
  return { methods: [...methods].sort().join(','), tools: [...tools].sort().join(',') };
}

// Anonymous introspection is limited in-isolate (zero KV ops): crawler waves
// after directory listings were burning the KV write budget one put per
// request, and metadata reads don't need globally-accurate accounting.
const ANON_LIMIT = 120;
const ANON_WINDOW_SECONDS = 60;

// Authed traffic keeps KV-backed accounting, per-account (quota is
// per-account, so keying on the key would let one account mint many keys to
// multiply its effective rate).
const authedRateLimit = rateLimit({
  scope: 'mcp',
  limit: 60,
  windowSeconds: 60,
  identify: (c) => c.get('keyCtx')?.usageSubject ?? c.get('keyCtx')?.keyId ?? 'unknown',
});

// Sign-up requests send an email, so they share the login-sized per-IP budget
// (KV-backed, same scope as POST /v1/auth/agent-signup). Claim polls are cheap
// D1 reads and ride the in-isolate limiter like introspection.
const signupRequestRateLimit = rateLimit({
  ...SIGNUP_RATE_LIMIT,
  identify: (c) => c.req.header('CF-Connecting-IP') ?? 'unknown',
});

/**
 * The lazy-auth gate (Claude's "Answer a protected call with 401 before the
 * MCP SDK runs"): a transport-level 401 with `resource_metadata` is the only
 * thing that starts sign-in in Claude, Cursor or ChatGPT — a 200 tool error
 * never does. Sent when a keyless call names a protected tool, or a data tool
 * once the day's preview budget is spent (the paywall, which the daily numbers
 * count as before via the `mcp_denied` point).
 */
async function oauthChallenge(
  c: Context<AppEnv>,
  reason: 'protected_tool' | 'preview_exhausted',
): Promise<Response> {
  const shape = await requestShape(c);
  const userAgent = c.req.header('User-Agent') ?? '';
  // blob6 = the preview's hashed client id (IP + UA), so the Daily numbers row can follow
  // a wall-hitter for an hour (`after wall 1h`, gankdat preview-wall-next-steps). No raw IP.
  const clientId = await previewClientId(c.req.header('CF-Connecting-IP') ?? 'unknown', userAgent);
  c.env.TRAFFIC.writeDataPoint({
    blobs: ['mcp_denied', userAgent, shape.methods, reason, shape.tools, clientId],
    doubles: [1],
    indexes: ['mcp_denied'],
  });
  const description =
    reason === 'protected_tool'
      ? 'Sign in to gankdat to use this tool with your account'
      : previewExhaustedMessage();
  // The header text is what a client shows first (120 chars, auth/oauth.ts): name every way on.
  const headline =
    reason === 'protected_tool'
      ? description
      : 'Preview limit reached: pay per call at /x402/data/<source>, call request_api_key for a free key, or sign in';
  return c.json({ error: 'invalid_token', error_description: description }, 401, {
    'WWW-Authenticate': bearerChallenge(c.env, headline),
  });
}

export const mcpRoute = new Hono<AppEnv>().post(
  '/',
  async (c, next) => {
    const origin = c.req.header('Origin');
    if (origin !== undefined && !mcpOriginAllowed(origin, c.env)) {
      return c.json(failure('forbidden', 'Origin not allowed for /mcp'), 403);
    }
    return next();
  },
  async (c, next) => {
    const kind = await anonymousKind(c);
    if (kind !== null) {
      const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
      const retryAfter = isolateRateLimit(`mcp:${ip}`, ANON_LIMIT, ANON_WINDOW_SECONDS);
      if (retryAfter > 0) {
        c.header('Retry-After', String(retryAfter));
        return c.json(
          failure(
            'rate_limited',
            `Rate limit exceeded (${ANON_LIMIT} per ${ANON_WINDOW_SECONDS}s); retry later`,
          ),
          429,
        );
      }
      if (kind === 'protected') return oauthChallenge(c, 'protected_tool');
      if (kind === 'preview') {
        const clientId = await previewClientId(ip, c.req.header('User-Agent') ?? '');
        if ((await previewCallsRemaining(c.env, clientId)) === 0) {
          return oauthChallenge(c, 'preview_exhausted');
        }
      }
      return kind === 'request' ? signupRequestRateLimit(c, next) : next();
    }
    // requireApiKey's 401 short-circuits before the analytics write in the
    // final handler, which would hide the strongest adoption signal there is:
    // an agent attempting tools/call without a key. Record rejections here.
    // Its 401 carries the resource_metadata pointer so an OAuth client with an
    // expired token refreshes instead of giving up.
    const response = await requireApiKey(MCP_NO_KEY_HINT, resourceMetadataUrl(c.env))(c, next);
    if (response instanceof Response && response.status === 401) {
      const shape = await requestShape(c);
      c.env.TRAFFIC.writeDataPoint({
        // blob5 = tool name(s) on tools/call: which dataset the agent wanted (task 52).
        blobs: [
          'mcp_denied',
          c.req.header('User-Agent') ?? '',
          shape.methods,
          presentsCredential(c.req.header('Authorization')) ? 'bad_key' : 'no_key',
          shape.tools,
        ],
        doubles: [1],
        indexes: ['mcp_denied'],
      });
    }
    return response;
  },
  // Anonymous requests were already limited above; keyCtx present ⇒ authed.
  async (c, next) => (c.get('keyCtx') ? authedRateLimit(c, next) : next()),
  async (c) => {
    // Adoption analytics (fire-and-forget, no request-path cost): who calls
    // /mcp and which method — splits crawler introspection (initialize,
    // tools/list) from real tool usage. UA only, no IPs (data-minimization).
    // Keyless tools/call on a data tool is the preview (its own kind, so the
    // daily numbers can tell a taste of the data from crawler introspection).
    const shape = await requestShape(c);
    const keyCtx = c.get('keyCtx') ?? null;
    const previewCall =
      !keyCtx && shape.tools !== '' && shape.tools.split(',').some((t) => !SIGNUP_TOOLS.has(t));
    const kind = keyCtx ? 'mcp_authed' : previewCall ? 'mcp_preview' : 'mcp_anon';
    const userAgent = c.req.header('User-Agent') ?? '';
    const clientId = await previewClientId(
      c.req.header('CF-Connecting-IP') ?? 'unknown',
      userAgent,
    );
    // blob6 = the key's account id on authed calls (an opaque D1 id, so `datasets 30d external`
    // can leave our own accounts out — metrics-dataset-queries-external, 2026-10-11), else the
    // hashed client id, so a request_api_key call after the preview wall is attributable to the
    // client that hit it.
    c.env.TRAFFIC.writeDataPoint({
      blobs: [
        kind,
        userAgent,
        shape.methods,
        '',
        shape.tools,
        keyCtx ? keyCtx.accountId : clientId,
      ],
      doubles: [1],
      indexes: [kind],
    });

    const server = buildMcpServer(c.env, keyCtx, { clientId, userAgent });
    // One JSON body per POST, not an SSE stream (gankdat `refresh-mcp-probe`, 2026-10-18).
    // With the stream, @hono/mcp returns the Response at once and the tool call runs
    // AFTER the fetch handler has returned, kept alive only by the open stream — the one
    // shape of work a Worker may drop, and a dropped call leaves the stream open until the
    // client gives up (the 10-18 keyless probe: 20 s, no body, while the keyed call a moment
    // later answered). In JSON mode the transport awaits the result inside the handler, so
    // the call runs where the runtime guarantees it, a death mid-call is an HTTP error the
    // checker can read, and a stateless server never had a notification to stream anyway.
    // The spec lets a server answer a POST with application/json; every client sends
    // `Accept: application/json, text/event-stream` (the SDK client parses both).
    const transport = new StreamableHTTPTransport({ enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(c);
    // The per-request server/transport are unreferenced after this returns and
    // GC'd by the isolate; no stream or timer is left open (POST only).
    return response ?? c.body(null, 202);
  },
);
