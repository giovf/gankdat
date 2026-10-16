import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { safeNext, startMagicLinkSignIn } from '../auth/login';
import {
  approveAuthRequest,
  authorizationServerMetadata,
  clientHost,
  createAuthRequest,
  denyAuthRequest,
  exchangeAuthorizationCode,
  isLoopbackRedirect,
  isRegisteredClientId,
  oauthKeyName,
  OAUTH_SCOPE,
  parseRegistration,
  protectedResourceMetadata,
  readAuthRequest,
  redirectUriAllowed,
  refreshAccessToken,
  registerClient,
  registrationResponse,
  REQUEST_ID_RE,
  resolveClient,
  validateAuthorizeParams,
} from '../auth/oauth';
import type { AuthRequest, TokenResult } from '../auth/oauth';
import { readSession, readSessionCookie } from '../auth/session';
import { escapeHtml, isSameOrigin, page } from '../lib/pages';
import { isolateRateLimit, rateLimit } from '../metering/ratelimit';
import type { AppEnv } from '../types';

// OAuth 2.1 authorization server for the MCP endpoint (auth/oauth.ts has the
// why). Four surfaces:
//   discovery  — the two RFC 9728 documents and the RFC 8414 one, public JSON
//   /register  — RFC 7591: a client POSTs its metadata (JSON) and gets a public
//                client_id back; Docker's MCP Toolkit, Cursor, ChatGPT and VS Code
//                sign in this way, Claude by CIMD (2026-10-10)
//   /authorize — browser pages: sign-in (magic link, when there is no session),
//                consent (when there is), both plain forms under the strict CSP
//   /token     — form-urlencoded, PKCE, no client secret, JSON out, never cached
// The user reaches /authorize in the popup Claude opens. Without a session the
// page emails a magic link whose `next` returns to this request; the link opens
// wherever the user reads mail, so the consent page — and the redirect back to
// Claude — happen in THAT tab, and the popup just says so. Deterministic and
// script-free; if the daily numbers show the hop losing people, a poller in the
// popup is the next step.
//
// Every leg writes one `oauth_funnel` analytics point (gankdat
// oauth-connect-funnel-check, 2026-10-09): `connect_account` was the most-wanted
// tool for a week with `oauth: 0 connects`, and nothing between the 401 and the
// code row said where the person stopped. The Daily numbers row reads the steps
// side by side (metrics.mjs), so the funnel is visible without anyone walking it.

interface SignedIn {
  accountId: string;
  email: string;
  plan: string;
}

async function currentAccount(c: Context<AppEnv>): Promise<SignedIn | null> {
  const sid = readSessionCookie(c);
  const rec = sid ? await readSession(c.env, sid) : null;
  if (!rec) return null;
  const acct = await c.env.DB.prepare('SELECT plan FROM accounts WHERE id = ?1')
    .bind(rec.accountId)
    .first<{ plan: string }>();
  return { accountId: rec.accountId, email: rec.email, plan: acct?.plan ?? 'free' };
}

/** One leg of the connect funnel, in the order a person walks them. */
type FunnelStep =
  | 'registered' // RFC 7591 /register issued a client_id (detail: the label it carries)
  | 'register_rejected' // detail: <error>: <description>
  | 'authorize' // a valid request was created (client document and redirect_uri verified)
  | 'authorize_rejected' // detail: bad_query | unknown_client | redirect_not_allowed | <protocol error>
  | 'signin_shown' // no session: the magic-link form (detail: new | continue | decision)
  | 'consent_shown' // signed in: the approve/cancel form (detail: new | continue)
  | 'email_sent' // detail: the magic-link outcome (sent | capped | disabled | send_failed)
  | 'approved' // detail: '' | repeat (a double-submitted form answered again)
  | 'denied'
  | 'expired' // a 410 page; detail: which leg found the request gone
  | 'token' // detail: grant_type
  | 'token_rejected'; // detail: <error>: <description>

/**
 * blob1 'oauth_funnel', blob2 user agent, blob3 step, blob4 the client host (what the
 * consent page names), blob5 detail. UA only, never an IP or an email.
 */
function funnel(c: Context<AppEnv>, step: FunnelStep, clientId: string | null, detail = ''): void {
  c.env.TRAFFIC.writeDataPoint({
    blobs: [
      'oauth_funnel',
      c.req.header('User-Agent') ?? '',
      step,
      clientId ? clientHost(clientId) : '',
      detail.slice(0, 160),
    ],
    doubles: [1],
    indexes: ['oauth_funnel'],
  });
}

// ── Pages ────────────────────────────────────────────────────────────────

function errorPage(title: string, text: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`);
}

function redirectHostLine(redirectUri: string): string {
  let host = redirectUri;
  try {
    host = new URL(redirectUri).host;
  } catch {
    // shown raw
  }
  const loopback = isLoopbackRedirect(redirectUri)
    ? `<p class="warn">${escapeHtml(host)} is a local address on this computer — approve only if you started this from an app running here (Claude Code, Cursor, an MCP Inspector).</p>`
    : '';
  return `<p>After you approve, you return to <strong>${escapeHtml(host)}</strong>.</p>${loopback}`;
}

function signInPage(req: AuthRequest, error: string | null): string {
  const host = clientHost(req.clientId);
  const err = error ? `<p class="warn">${escapeHtml(error)}</p>` : '';
  return page(
    'Sign in',
    `<h1>Connect gankdat to ${escapeHtml(host)}</h1>
<p>Sign in with your email to let <strong>${escapeHtml(host)}</strong> query UK &amp; EU registers with your plan's credits. New address? A free account (250 credits/month, no card) is created for you.</p>
${err}
<form method="POST" action="/authorize/login">
<input type="hidden" name="request" value="${req.id}">
<input type="email" name="email" placeholder="you@company.com" required autofocus>
<button type="submit">$ email me a sign-in link</button>
</form>`,
  );
}

function checkEmailPage(req: AuthRequest, email: string): string {
  const host = clientHost(req.clientId);
  return page(
    'Check your email',
    `<h1>Check your email</h1>
<p>We sent a sign-in link to <strong>${escapeHtml(email)}</strong>. Open it on this device: it finishes the sign-in, asks you to approve the connection and returns you to <strong>${escapeHtml(host)}</strong>.</p>
<p>The link works once and expires in 15 minutes. This window can be closed.</p>`,
  );
}

function consentPage(req: AuthRequest, account: SignedIn): string {
  const host = clientHost(req.clientId);
  // A CIMD client's host is verified (its document lives there); a registered client only
  // said who it is, so the page says so and leans on the redirect line below.
  const selfRegistered = isRegisteredClientId(req.clientId)
    ? `<p class="warn">${escapeHtml(host)} registered itself with gankdat; nobody has verified who runs it. Approve only if you just started this from that app.</p>`
    : '';
  return page(
    'Approve connection',
    `<h1>Connect gankdat to ${escapeHtml(host)}</h1>
<p>Signed in as <strong>${escapeHtml(account.email)}</strong> (${escapeHtml(account.plan)} plan).</p>
${selfRegistered}
<ul>
<li><strong>${escapeHtml(host)}</strong> will be able to query datasets and change feeds using your plan's credits (scope <code>${OAUTH_SCOPE}</code>).</li>
<li>It cannot see or manage your keys, billing or email.</li>
<li>The connection appears as key <code>${escapeHtml(oauthKeyName(req.clientId))}</code> at <a href="/account">/account</a> — revoke it there to disconnect.</li>
</ul>
${redirectHostLine(req.redirectUri)}
<form method="POST" action="/authorize/decision" data-single-submit>
<input type="hidden" name="request" value="${req.id}">
<button type="submit" name="decision" value="approve">$ approve and connect</button>
<button type="submit" name="decision" value="deny" class="secondary">cancel</button>
</form>
<script src="/consent.js" defer></script>`,
  );
}

function expiredPage(): string {
  return errorPage(
    'Request expired',
    'This connection request has expired or was already answered. Go back to the app and connect again.',
  );
}

// ── /authorize ───────────────────────────────────────────────────────────

const authorizeQuerySchema = z.object({
  response_type: z.string().optional(),
  client_id: z.string().min(1).max(512),
  redirect_uri: z.string().min(1).max(2048),
  state: z.string().max(1024).optional(),
  scope: z.string().max(256).optional(),
  code_challenge: z.string().max(256).optional(),
  code_challenge_method: z.string().max(16).optional(),
  resource: z.string().max(2048).optional(),
});

function redirectWith(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

/** Render whatever the pending request needs next: consent when signed in, else sign-in. */
async function renderAuthorize(
  c: Context<AppEnv>,
  req: AuthRequest,
  status: 200 | 401 = 200,
  how: 'new' | 'continue' | 'decision' = 'new',
): Promise<Response> {
  const account = await currentAccount(c);
  funnel(c, account ? 'consent_shown' : 'signin_shown', req.clientId, how);
  return c.html(account ? consentPage(req, account) : signInPage(req, null), status);
}

// Sign-in emails share the browser login budget (per IP, KV-backed).
const authorizeLoginRateLimit = rateLimit({
  scope: 'login',
  limit: 5,
  windowSeconds: 900,
  identify: (c) => c.req.header('CF-Connecting-IP') ?? 'unknown',
});

const AUTHORIZE_LIMIT = 30;
const REGISTER_LIMIT = 10; // a client registers once; a burst is a scanner
const TOKEN_LIMIT = 300; // refreshes arrive from Claude's shared egress range

function ipLimited(c: Context<AppEnv>, scope: string, limit: number): Response | null {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const retryAfter = isolateRateLimit(`${scope}:${ip}`, limit, 60);
  if (retryAfter <= 0) return null;
  c.header('Retry-After', String(retryAfter));
  return c.json({ error: 'temporarily_unavailable', error_description: 'rate limited' }, 429);
}

const noStore = { 'Cache-Control': 'no-store', Pragma: 'no-cache' } as const;

export const oauthRoutes = new Hono<AppEnv>()
  .get('/.well-known/oauth-protected-resource', (c) => c.json(protectedResourceMetadata(c.env)))
  .get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(protectedResourceMetadata(c.env)))
  .get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(c.env)))
  // RFC 7591 §3: JSON in, 201 + the registered metadata out, 400 + {error} otherwise.
  // Open registration (no initial access token), public clients only, no secret issued:
  // a registered client can do nothing a CIMD client cannot, and the user still approves
  // every connection on the consent page, which says the client named itself.
  .post('/register', async (c) => {
    const limited = ipLimited(c, 'oauth:register', REGISTER_LIMIT);
    if (limited) return limited;
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const parsed = parseRegistration(body);
    if ('error' in parsed) {
      funnel(c, 'register_rejected', null, `${parsed.error}: ${parsed.description}`);
      return c.json({ error: parsed.error, error_description: parsed.description }, 400, noStore);
    }
    const client = await registerClient(c.env, parsed);
    funnel(
      c,
      'registered',
      client.clientId,
      client.redirectUris.some(isLoopbackRedirect) ? 'loopback' : 'https',
    );
    return c.json(registrationResponse(client), 201, noStore);
  })
  .get('/authorize', async (c) => {
    const limited = ipLimited(c, 'oauth:authorize', AUTHORIZE_LIMIT);
    if (limited) return limited;

    // Continuation (after the magic-link hop, or a reload): render by request id.
    const requestId = c.req.query('request');
    if (requestId !== undefined) {
      const req = REQUEST_ID_RE.test(requestId) ? await readAuthRequest(c.env, requestId) : null;
      if (!req) {
        funnel(c, 'expired', null, 'authorize');
        return c.html(expiredPage(), 410);
      }
      return renderAuthorize(c, req, 200, 'continue');
    }

    const parsed = authorizeQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      funnel(c, 'authorize_rejected', c.req.query('client_id') ?? null, 'bad_query');
      return c.html(errorPage('Invalid request', 'client_id and redirect_uri are required.'), 400);
    }
    const q = parsed.data;
    // The client and its redirect_uri are verified BEFORE anything is sent to
    // that URI: an unverified redirect target never receives an error either.
    const client = await resolveClient(c.env, q.client_id);
    if (!client) {
      funnel(c, 'authorize_rejected', q.client_id, 'unknown_client');
      return c.html(
        errorPage(
          'Unknown client',
          `${q.client_id} is not a valid client — the client_id must be one issued by POST /register (RFC 7591) or an https URL serving a client metadata document whose client_id field equals that URL.`,
        ),
        400,
      );
    }
    if (!redirectUriAllowed(q.redirect_uri, client.redirectUris)) {
      funnel(c, 'authorize_rejected', q.client_id, 'redirect_not_allowed');
      return c.html(
        errorPage(
          'Redirect not allowed',
          `${q.redirect_uri} is not among the redirect URIs ${clientHost(q.client_id)} registers.`,
        ),
        400,
      );
    }
    const paramError = validateAuthorizeParams(c.env, q);
    if (paramError) {
      funnel(
        c,
        'authorize_rejected',
        q.client_id,
        `${paramError.error}: ${paramError.description}`,
      );
      return c.redirect(
        redirectWith(q.redirect_uri, {
          error: paramError.error,
          error_description: paramError.description,
          state: q.state,
        }),
        302,
      );
    }
    const req = await createAuthRequest(c.env, {
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      state: q.state ?? null,
      codeChallenge: q.code_challenge!,
      scope: OAUTH_SCOPE,
      resource: q.resource ?? null,
    });
    funnel(c, 'authorize', q.client_id);
    return renderAuthorize(c, req);
  })
  // Email the magic link with `next` pointing back at this request.
  .post('/authorize/login', authorizeLoginRateLimit, async (c) => {
    if (!isSameOrigin(c.req.url, c.req.header('Sec-Fetch-Site'), c.req.header('Origin'))) {
      return c.html(expiredPage(), 403);
    }
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const requestId = typeof body.request === 'string' ? body.request : '';
    const req = REQUEST_ID_RE.test(requestId) ? await readAuthRequest(c.env, requestId) : null;
    if (!req) {
      funnel(c, 'expired', null, 'login');
      return c.html(expiredPage(), 410);
    }
    const email = z.email().safeParse(typeof body.email === 'string' ? body.email.trim() : '');
    if (!email.success) return c.html(signInPage(req, 'Enter a valid email address.'), 400);
    const next = safeNext(`/authorize?request=${req.id}`);
    const outcome = await startMagicLinkSignIn(c.env, email.data, next);
    funnel(c, 'email_sent', req.clientId, outcome);
    switch (outcome) {
      case 'disabled':
        return c.html(signInPage(req, 'Email sign-in is not configured yet.'), 503);
      case 'send_failed':
        return c.html(signInPage(req, 'Could not send the email — please try again.'), 502);
      default:
        // 'capped' renders the same page: no throttle signal, like /v1/auth/login.
        return c.html(checkEmailPage(req, email.data));
    }
  })
  .post('/authorize/decision', async (c) => {
    if (!isSameOrigin(c.req.url, c.req.header('Sec-Fetch-Site'), c.req.header('Origin'))) {
      return c.html(expiredPage(), 403);
    }
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const requestId = typeof body.request === 'string' ? body.request : '';
    const req = REQUEST_ID_RE.test(requestId) ? await readAuthRequest(c.env, requestId) : null;
    if (!req) {
      // Already consumed: a repeated approval by the account that approved it moments ago
      // (double-submitted form) is answered again rather than stranded on "expired".
      const account = body.decision === 'approve' ? await currentAccount(c) : null;
      const again = account ? await approveAuthRequest(c.env, requestId, account) : null;
      if (!again) {
        funnel(c, 'expired', null, 'decision');
        return c.html(expiredPage(), 410);
      }
      funnel(c, 'approved', again.clientId, 'repeat');
      return c.redirect(
        redirectWith(again.redirectUri, { code: again.code, state: again.state }),
        302,
      );
    }
    if (body.decision === 'deny') {
      const denied = await denyAuthRequest(c.env, req.id);
      if (!denied) {
        funnel(c, 'expired', req.clientId, 'decision');
        return c.html(expiredPage(), 410);
      }
      funnel(c, 'denied', req.clientId);
      return c.redirect(
        redirectWith(denied.redirectUri, {
          error: 'access_denied',
          error_description: 'the user cancelled',
          state: denied.state,
        }),
        302,
      );
    }
    const account = await currentAccount(c);
    if (!account) return renderAuthorize(c, req, 401, 'decision');
    const approved = await approveAuthRequest(c.env, req.id, account);
    if (!approved) {
      funnel(c, 'expired', req.clientId, 'decision');
      return c.html(expiredPage(), 410);
    }
    funnel(c, 'approved', req.clientId);
    return c.redirect(
      redirectWith(approved.redirectUri, { code: approved.code, state: approved.state }),
      302,
    );
  })
  // RFC 6749 §4.1.3 / §6: form-urlencoded in (JSON tolerated), JSON out,
  // never cached. Public clients only, so no client authentication.
  .post('/token', async (c) => {
    const limited = ipLimited(c, 'oauth:token', TOKEN_LIMIT);
    if (limited) return limited;
    const contentType = c.req.header('Content-Type') ?? '';
    let body: Record<string, unknown> = {};
    try {
      body = contentType.includes('application/json')
        ? ((await c.req.json()) as Record<string, unknown>)
        : ((await c.req.parseBody()) as Record<string, unknown>);
    } catch {
      body = {};
    }
    const str = (k: string): string | null => (typeof body[k] === 'string' ? body[k] : null);
    let result: TokenResult;
    switch (str('grant_type')) {
      case 'authorization_code':
        if (!str('code') || !str('code_verifier') || !str('client_id')) {
          result = {
            ok: false,
            error: 'invalid_request',
            description: 'code, code_verifier and client_id are required',
          };
          break;
        }
        result = await exchangeAuthorizationCode(c.env, {
          code: str('code')!,
          clientId: str('client_id')!,
          redirectUri: str('redirect_uri'),
          codeVerifier: str('code_verifier')!,
        });
        break;
      case 'refresh_token':
        if (!str('refresh_token')) {
          result = {
            ok: false,
            error: 'invalid_request',
            description: 'refresh_token is required',
          };
          break;
        }
        result = await refreshAccessToken(c.env, {
          refreshToken: str('refresh_token')!,
          clientId: str('client_id'),
        });
        break;
      default:
        result = {
          ok: false,
          error: 'unsupported_grant_type',
          description: 'grant_type must be authorization_code or refresh_token',
        };
    }
    if (!result.ok) {
      funnel(c, 'token_rejected', str('client_id'), `${result.error}: ${result.description}`);
      return c.json({ error: result.error, error_description: result.description }, 400, noStore);
    }
    funnel(c, 'token', result.clientId, str('grant_type') ?? '');
    // The proof number for this build: tokens issued per client (blob4 = the
    // client host — claude.ai, Claude Code's, Cursor's), grant type in blob3.
    c.env.TRAFFIC.writeDataPoint({
      blobs: [
        'oauth_token',
        c.req.header('User-Agent') ?? '',
        str('grant_type') ?? '',
        clientHost(result.clientId),
        '',
      ],
      doubles: [1],
      indexes: ['oauth_token'],
    });
    return c.json(result.body, 200, noStore);
  });
