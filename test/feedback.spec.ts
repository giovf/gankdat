import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const URL = 'https://example.com/v1/feedback';

async function post(body: unknown): Promise<Response> {
  return SELF.fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/feedback', () => {
  it('stores a message without requiring an email', async () => {
    const res = await post({ message: 'please add Manchester planning data', page: '/stats' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { received: boolean } };
    expect(body.data.received).toBe(true);

    const row = await env.DB.prepare('SELECT message, email, page FROM feedback').first<{
      message: string;
      email: string | null;
      page: string | null;
    }>();
    expect(row).toMatchObject({
      message: 'please add Manchester planning data',
      email: null,
      page: '/stats',
    });
  });

  it('stores the optional email when given', async () => {
    await post({ message: 'sanctions screening please', email: 'dev@example.com' });
    const row = await env.DB.prepare('SELECT email FROM feedback').first<{ email: string }>();
    expect(row?.email).toBe('dev@example.com');
  });

  it('rejects empty/too-short and malformed bodies with the error envelope', async () => {
    for (const bad of [{}, { message: 'hi' }, { message: 'long enough', email: 'not-an-email' }]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: { code: string } };
      expect(body.error.code).toBe('bad_request');
    }
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback').first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it('rate limits per IP', async () => {
    let limited = false;
    for (let i = 0; i < 11; i++) {
      const res = await post({ message: `feedback number ${i} with enough length` });
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});
