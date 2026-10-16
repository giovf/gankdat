import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyTurnstile } from '../src/auth/turnstile';
import { authRoutes } from '../src/routes/auth';
import { waitlistRoute } from '../src/routes/waitlist';
import type { SuccessEnvelope } from '../src/lib/envelope';

function stubSiteverify(success: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/turnstile/v0/siteverify'))
        return Promise.resolve(Response.json({ success }));
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

const withTurnstile = (): CloudflareBindings => ({ ...env, TURNSTILE_SECRET_KEY: 'test-secret' });

afterEach(() => vi.unstubAllGlobals());

describe('verifyTurnstile', () => {
  it('allows through when disabled (no secret)', async () => {
    expect(await verifyTurnstile(env, undefined, undefined)).toBe(true);
  });

  it('rejects a missing token when enabled', async () => {
    expect(await verifyTurnstile(withTurnstile(), undefined, undefined)).toBe(false);
  });

  it('verifies the token via siteverify when enabled', async () => {
    stubSiteverify(true);
    expect(await verifyTurnstile(withTurnstile(), 'tok', '1.2.3.4')).toBe(true);
    stubSiteverify(false);
    expect(await verifyTurnstile(withTurnstile(), 'tok', undefined)).toBe(false);
  });
});

describe('POST /v1/waitlist with Turnstile enabled', () => {
  const post = (
    body: Record<string, unknown>,
    envOverride: CloudflareBindings,
  ): Promise<Response> =>
    Promise.resolve(
      waitlistRoute.request(
        '/',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        envOverride,
      ),
    );

  it('400s a signup with no captcha token', async () => {
    const res = await post({ email: 'a@example.com' }, withTurnstile());
    expect(res.status).toBe(400);
  });

  it('subscribes when the captcha token verifies', async () => {
    stubSiteverify(true);
    const res = await post(
      { email: 'b@example.com', 'cf-turnstile-response': 'tok' },
      withTurnstile(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<{ subscribed: boolean }>;
    expect(body.data.subscribed).toBe(true);
  });

  it('still works with no token when Turnstile is disabled', async () => {
    const res = await post({ email: 'c@example.com' }, env);
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/auth/login with Turnstile enabled', () => {
  const post = (
    body: Record<string, unknown>,
    envOverride: CloudflareBindings,
  ): Promise<Response> =>
    Promise.resolve(
      authRoutes.request(
        '/login',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        envOverride,
      ),
    );

  it('400s a sign-in request with no captcha token', async () => {
    const res = await post({ email: 'login-a@example.com' }, withTurnstile());
    expect(res.status).toBe(400);
  });

  it('sends the link when the captcha token verifies', async () => {
    // Login verifies the captcha (siteverify) then sends the email (Resend).
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes('/turnstile/v0/siteverify'))
          return Promise.resolve(Response.json({ success: true }));
        if (url.startsWith('https://api.resend.com/'))
          return Promise.resolve(Response.json({ id: 'e1' }));
        throw new Error(`unexpected fetch in test: ${url}`);
      }),
    );
    const res = await post(
      { email: 'login-b@example.com', 'cf-turnstile-response': 'tok' },
      withTurnstile(),
    );
    expect(res.status).toBe(200);
  });
});
