import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuccessEnvelope } from '../src/lib/envelope';

const BASE = 'https://example.com';

// Make the outbound Resend call hermetic (login sends the magic-link email).
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

afterEach(() => vi.unstubAllGlobals());

async function latestMagicToken(): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT token FROM magic_tokens ORDER BY expires_at DESC LIMIT 1',
  ).first<{ token: string }>();
  return row!.token;
}

/** Full passwordless flow → returns the session Cookie header for authed calls. */
async function signIn(email: string): Promise<string> {
  stubResend();
  const login = await SELF.fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  expect(login.status).toBe(200);
  const token = await latestMagicToken();
  vi.unstubAllGlobals();

  // GET shows a confirm page (no session yet); the same-origin POST signs in.
  const page = await SELF.fetch(`${BASE}/v1/auth/verify?token=${token}`);
  expect(page.status).toBe(200);
  expect(page.headers.get('set-cookie')).toBeNull();

  const verify = await SELF.fetch(`${BASE}/v1/auth/verify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: `token=${token}`,
    redirect: 'manual',
  });
  expect(verify.status).toBe(302);
  expect(verify.headers.get('location')).toContain('/account');
  const setCookie = verify.headers.get('set-cookie') ?? '';
  const m = /fapi_session=([^;]+)/.exec(setCookie);
  expect(m).toBeTruthy();
  return `fapi_session=${m![1]}`;
}

describe('magic-link auth + account API', () => {
  it('signs in via magic link and exposes the account', async () => {
    const cookie = await signIn('owner@example.com');
    const res = await SELF.fetch(`${BASE}/v1/account`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<{
      email: string;
      plan: string;
      keys: unknown[];
    }>;
    expect(body.data).toMatchObject({ email: 'owner@example.com', plan: 'free' });
  });

  it('creates a key that authenticates, then revokes it', async () => {
    const cookie = await signIn('keys@example.com');
    const created = (await (
      await SELF.fetch(`${BASE}/v1/account/keys`, {
        method: 'POST',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'prod' }),
      })
    ).json()) as SuccessEnvelope<{ id: string; key: string }>;
    expect(created.data.key).toMatch(/^fapi_/);

    // /v1/usage is authed but origin-free — a clean check that the key resolves.
    const ok = await SELF.fetch(`${BASE}/v1/usage`, {
      headers: { Authorization: `Bearer ${created.data.key}` },
    });
    expect(ok.status).toBe(200);

    const del = await SELF.fetch(`${BASE}/v1/account/keys/${created.data.id}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/v1/usage`, {
      headers: { Authorization: `Bearer ${created.data.key}` },
    });
    expect(after.status).toBe(401);
  });

  it('rejects account routes without a session', async () => {
    expect((await SELF.fetch(`${BASE}/v1/account`)).status).toBe(401);
  });

  it('expires a session past the absolute lifetime cap and clears the cookie', async () => {
    const cookie = await signIn('old@example.com');
    const sid = /fapi_session=([^;]+)/.exec(cookie)![1]!;
    // Backdate createdAt beyond the 30-day absolute cap.
    const rec = await env.CACHE.get<{ accountId: string; email: string }>(`session:${sid}`, 'json');
    await env.CACHE.put(
      `session:${sid}`,
      JSON.stringify({
        ...rec,
        createdAt: Date.now() - 31 * 24 * 3600 * 1000,
        refreshedAt: Date.now(),
      }),
    );
    const res = await SELF.fetch(`${BASE}/v1/account`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    // The session is destroyed, so it can't be reused even before its idle TTL.
    expect(await env.CACHE.get(`session:${sid}`)).toBeNull();
  });

  it('returns 502 when the email provider rejects the send', async () => {
    // e.g. Resend's sandbox 403 ("can only send to your own address") — the
    // API must not claim the email is on its way.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({ statusCode: 403, name: 'validation_error' }, { status: 403 }),
        ),
      ),
    );
    const res = await SELF.fetch(`${BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rejected@example.com' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unavailable');
  });

  it('rejects an invalid or reused magic token', async () => {
    const post = (token: string) =>
      SELF.fetch(`${BASE}/v1/auth/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: `token=${token}`,
        redirect: 'manual',
      });

    const bad = await post('deadbeef');
    expect(bad.status).toBe(302);
    expect(bad.headers.get('location')).toContain('error=link_expired');

    stubResend();
    await SELF.fetch(`${BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'single@example.com' }),
    });
    const token = await latestMagicToken();
    vi.unstubAllGlobals();

    const first = await post(token);
    expect(first.headers.get('location')).toContain('/account');
    const second = await post(token);
    expect(second.headers.get('location')).toContain('error=link_expired'); // single-use
  });

  it('blocks login-CSRF: a cross-site POST to /verify does not create a session', async () => {
    stubResend();
    await SELF.fetch(`${BASE}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'attacker@example.com' }),
    });
    const token = await latestMagicToken();
    vi.unstubAllGlobals();

    // Attacker auto-submits their own token from another origin.
    const res = await SELF.fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: `token=${token}`,
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('error=link_expired');
    expect(res.headers.get('set-cookie')).toBeNull(); // no session minted

    // The token was NOT consumed — a legitimate same-origin POST still works.
    const ok = await SELF.fetch(`${BASE}/v1/auth/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'same-origin',
      },
      body: `token=${token}`,
      redirect: 'manual',
    });
    expect(ok.headers.get('location')).toContain('/account');
    expect(ok.headers.get('set-cookie')).toContain('fapi_session=');
  });
});
