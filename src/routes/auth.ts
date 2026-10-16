import { Hono } from 'hono';
import { z } from 'zod';
import { getOrCreateAccount, normalizeEmail } from '../auth/accounts';
import { emailSendAllowed, recordEmailSend } from '../auth/emailcap';
import { safeNext, startMagicLinkSignIn } from '../auth/login';
import { consumeMagicToken } from '../auth/magiclink';
import {
  clearedSessionCookie,
  createSession,
  destroySession,
  readSessionCookie,
  sessionCookie,
} from '../auth/session';
import {
  approveAgentSignup,
  claimAgentKey,
  createAgentSignup,
  peekAgentSignup,
  CLAIM_RETRY_SECONDS,
  SIGNUP_RATE_LIMIT,
} from '../auth/signup';
import { turnstileEnabled, verifyTurnstile } from '../auth/turnstile';
import { emailEnabled, sendEmail } from '../email/send';
import { agentKeyRequestEmail } from '../email/templates';
import { publicBaseUrl } from '../lib/constants';
import { failure, success } from '../lib/envelope';
import { escapeHtml, isSameOrigin, page } from '../lib/pages';
import { rateLimit } from '../metering/ratelimit';
import type { AppEnv } from '../types';

const loginSchema = z.object({ email: z.email() });
const agentSignupSchema = z.object({
  email: z.email(),
  client_name: z.string().trim().min(1).max(60).optional(),
});
const claimSchema = z.object({ request_id: z.string().min(1), claim_secret: z.string().min(1) });

// Cap sign-in requests per IP so the endpoint can't be used to spam inboxes.
const loginRateLimit = rateLimit({
  scope: 'login',
  limit: 5,
  windowSeconds: 900,
  identify: (c) => c.req.header('CF-Connecting-IP') ?? 'unknown',
});

// Agent sign-up requests share the login budget shape (per IP) and, via
// auth/emailcap.ts, the per-email cap with browser login.
const signupRateLimit = rateLimit({
  ...SIGNUP_RATE_LIMIT,
  identify: (c) => c.req.header('CF-Connecting-IP') ?? 'unknown',
});

function confirmPage(token: string, next: string | null): string {
  const t = token.replace(/[^a-zA-Z0-9]/g, ''); // token is hex; strip anything else defensively
  const nextField = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : '';
  const what = next
    ? 'Click to finish signing in — you will then be asked to approve the connection.'
    : 'Click to finish signing in to gankdat on this device.';
  return page(
    'Sign in',
    `<h1>Confirm sign-in</h1>
<p>${what}</p>
<form method="POST" action="/v1/auth/verify">
<input type="hidden" name="token" value="${t}">${nextField}
<button type="submit">$ sign me in</button>
</form>`,
  );
}

// The approval page for an agent's key request: shows the code the agent
// displayed so the user can tell their own request from a stranger's, and
// says plainly what approving does (a key on THEIR account, inheriting its plan).
function approvePage(
  token: string,
  pending: { email: string; code: string; client_name: string | null },
): string {
  const t = token.replace(/[^a-zA-Z0-9]/g, '');
  const who = pending.client_name ? `"${escapeHtml(pending.client_name)}"` : 'An AI agent or app';
  return page(
    'Approve API key',
    `<h1>Approve an API key request</h1>
<p>${who} asked for a gankdat API key for <strong>${escapeHtml(pending.email)}</strong>. Approve only if this code matches the one your agent showed you:</p>
<p class="code">${escapeHtml(pending.code)}</p>
<p>The key is issued to your account (created if new), inherits its plan and can be revoked any time at <a href="/account">/account</a>. If you didn't ask for this, close this page — nothing happens.</p>
<form method="POST" action="/v1/auth/approve">
<input type="hidden" name="token" value="${t}">
<button type="submit">$ approve and issue the key</button>
</form>`,
  );
}

function approvedPage(code: string): string {
  return page(
    'Approved',
    `<h1>Key request ${escapeHtml(code)} approved</h1>
<p>Your agent can now collect its key (it has 24 hours to do so). Manage or revoke keys at <a href="/account">/account</a>.</p>`,
  );
}

function linkExpiredPage(): string {
  return page(
    'Link expired',
    `<h1>This link has expired</h1>
<p>Approval links work once and expire after 30 minutes. Ask your agent to request a key again.</p>`,
  );
}

export const authRoutes = new Hono<AppEnv>()
  .post('/login', loginRateLimit, async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = loginSchema.safeParse(raw);
    if (!parsed.success) return c.json(failure('bad_request', 'A valid email is required'), 400);
    // CAPTCHA before the (rate-limited but still abusable) email send. Dark
    // until TURNSTILE_SECRET_KEY is set — verifyTurnstile returns true then.
    if (turnstileEnabled(c.env)) {
      const token = (raw['cf-turnstile-response'] ?? raw['turnstile_token']) as string | undefined;
      if (!(await verifyTurnstile(c.env, token, c.req.header('CF-Connecting-IP')))) {
        return c.json(failure('bad_request', 'CAPTCHA verification failed; please retry'), 400);
      }
    }
    if (!emailEnabled(c.env)) {
      return c.json(failure('unavailable', 'Email sign-in is not configured yet'), 503);
    }
    // Silent per-email cap: the send is skipped over the cap, but the response
    // stays the generic one so the behaviour is identical to a normal request.
    const outcome = await startMagicLinkSignIn(c.env, parsed.data.email, null);
    if (outcome === 'send_failed') {
      return c.json(
        failure('unavailable', 'Could not send the sign-in email — please try again shortly'),
        502,
      );
    }
    // Same response whether or not the email has an account or was capped (no
    // enumeration, no throttle signal).
    return c.json(
      success({
        sent: true,
        message: 'Check your email for a sign-in link — it expires in 15 minutes.',
      }),
    );
  })
  // Clicking the emailed link lands here (GET): show a confirm page but do NOT
  // consume the token or create a session. This defeats passive link-prefetchers
  // /mail scanners (which issue a GET) and forces the actual sign-in through a
  // same-origin POST — closing login-CSRF, where an attacker's own token could
  // otherwise be auto-submitted to log a victim into the attacker's account.
  // `next` (only the OAuth consent page for a request id — auth/login.ts
  // safeNext) sends the signed-in user back to the authorization they started
  // from Claude instead of the dashboard.
  .get('/verify', (c) => {
    const token = c.req.query('token') ?? '';
    if (!token) return c.redirect(`${publicBaseUrl(c.env)}/account?error=link_expired`, 302);
    return c.html(confirmPage(token, safeNext(c.req.query('next'))));
  })
  .post('/verify', async (c) => {
    const base = publicBaseUrl(c.env);
    if (!isSameOrigin(c.req.url, c.req.header('Sec-Fetch-Site'), c.req.header('Origin'))) {
      return c.redirect(`${base}/account?error=link_expired`, 302);
    }
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof body.token === 'string' ? body.token : '';
    const next = safeNext(typeof body.next === 'string' ? body.next : undefined);
    const email = await consumeMagicToken(c.env, token);
    if (!email) return c.redirect(`${base}/account?error=link_expired`, 302);
    const account = await getOrCreateAccount(c.env, email);
    const sid = await createSession(c.env, { accountId: account.id, email });
    c.header('Set-Cookie', sessionCookie(sid));
    return c.redirect(`${base}${next ?? '/account'}`, 302);
  })
  // ── Agent-side sign-up (REST twin of the MCP tools request_api_key /
  // claim_api_key; see auth/signup.ts). No CAPTCHA (agents can't solve one):
  // the per-IP and per-email caps are the abuse valves, and the human's click
  // is the gate.
  .post('/agent-signup', signupRateLimit, async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = agentSignupSchema.safeParse(raw);
    if (!parsed.success) return c.json(failure('bad_request', 'A valid email is required'), 400);
    if (!emailEnabled(c.env)) {
      return c.json(failure('unavailable', 'Email sign-up is not configured yet'), 503);
    }
    const email = normalizeEmail(parsed.data.email);
    if (!(await emailSendAllowed(c.env, email))) {
      return c.json(
        failure('rate_limited', 'Too many sign-up emails for this address; retry in an hour'),
        429,
      );
    }
    const { request, approveToken } = await createAgentSignup(
      c.env,
      email,
      parsed.data.client_name ?? null,
    );
    const link = `${publicBaseUrl(c.env)}/v1/auth/approve?token=${approveToken}`;
    const sent = await sendEmail(
      c.env,
      agentKeyRequestEmail(email, link, request.code, parsed.data.client_name ?? null),
    );
    if (!sent) {
      return c.json(
        failure('unavailable', 'Could not send the approval email — please try again shortly'),
        502,
      );
    }
    await recordEmailSend(c.env, email);
    return c.json(
      success({
        ...request,
        next: `Show the user the code ${request.code}; they approve the emailed link. Then POST /v1/auth/agent-signup/claim with request_id and claim_secret (every ${CLAIM_RETRY_SECONDS}s) until status is "approved".`,
      }),
      202,
    );
  })
  .post('/agent-signup/claim', async (c) => {
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = claimSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(failure('bad_request', 'request_id and claim_secret are required'), 400);
    }
    const result = await claimAgentKey(c.env, parsed.data.request_id, parsed.data.claim_secret);
    switch (result.status) {
      case 'approved':
        return c.json(
          success({
            status: 'approved',
            api_key: result.api_key,
            key_id: result.key_id,
            plan: result.plan,
            message:
              'Store this key now — it is shown only once. Send it as: Authorization: Bearer <key>',
          }),
        );
      case 'pending':
        return c.json(
          success({
            status: 'pending',
            approve_by: result.approve_by,
            retry_after_seconds: CLAIM_RETRY_SECONDS,
          }),
        );
      case 'not_found':
        return c.json(failure('not_found', 'Unknown request_id or wrong claim_secret'), 404);
      case 'claimed':
        return c.json(failure('gone', 'This request already issued its key'), 410);
      case 'key_limit':
        return c.json(
          failure('bad_request', 'Key limit reached (25 active) — revoke a key at /account first'),
          400,
        );
      default:
        return c.json(failure('gone', 'This request expired; start a new one'), 410);
    }
  })
  // Clicking the emailed approval link: GET renders, POST (same-origin) approves —
  // the same anti-prefetch / anti-CSRF shape as /verify.
  .get('/approve', async (c) => {
    const token = c.req.query('token') ?? '';
    const pending = await peekAgentSignup(c.env, token);
    if (!pending) return c.html(linkExpiredPage(), 410);
    return c.html(approvePage(token, pending));
  })
  .post('/approve', async (c) => {
    if (!isSameOrigin(c.req.url, c.req.header('Sec-Fetch-Site'), c.req.header('Origin'))) {
      return c.html(linkExpiredPage(), 403);
    }
    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const token = typeof body.token === 'string' ? body.token : '';
    const approved = await approveAgentSignup(c.env, token);
    if (!approved) return c.html(linkExpiredPage(), 410);
    return c.html(approvedPage(approved.code));
  })
  .post('/logout', async (c) => {
    const sid = readSessionCookie(c);
    if (sid) await destroySession(c.env, sid);
    c.header('Set-Cookie', clearedSessionCookie());
    return c.json(success({ signed_out: true }));
  });
