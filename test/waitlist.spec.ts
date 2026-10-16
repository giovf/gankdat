import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';

const WAITLIST_URL = 'https://example.com/v1/waitlist';

function post(email: string): Promise<Response> {
  return SELF.fetch(WAITLIST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, source: 'test' }),
  });
}

describe('POST /v1/waitlist', () => {
  it('stores an email and is idempotent on duplicates', async () => {
    const first = await post('dana@example.com');
    expect(first.status).toBe(200);
    const body = (await first.json()) as SuccessEnvelope<{ subscribed: boolean }>;
    expect(body.data.subscribed).toBe(true);

    const second = await post('dana@example.com');
    expect(second.status).toBe(200);

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM waitlist WHERE email = 'dana@example.com'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('rejects invalid emails with field details', async () => {
    const res = await post('not-an-email');
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.details).toEqual([expect.objectContaining({ field: 'email' })]);
  });

  it('rate-limits hammering per IP', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post(`w${i}@example.com`)).status).toBe(200);
    }
    const eleventh = await post('w11@example.com');
    expect(eleventh.status).toBe(429);
  });
});

// Static assets (/, /docs.html, /llms.txt) are NOT emulated by the vitest
// Workers pool — they're verified live via wrangler dev (see the project
// verify skill), which serves the real assets binding.
