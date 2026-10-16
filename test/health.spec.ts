import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ErrorEnvelope, SuccessEnvelope } from '../src/lib/envelope';

describe('GET /v1/health', () => {
  it('returns the success envelope with status and version', async () => {
    const res = await SELF.fetch('https://example.com/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SuccessEnvelope<{ status: string; version: string }>;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('includes an X-Request-Id response header', async () => {
    const res = await SELF.fetch('https://example.com/v1/health');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

describe('unknown routes', () => {
  it('returns the exact error-envelope shape with code not_found', async () => {
    const res = await SELF.fetch('https://example.com/v1/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'not_found',
        message: expect.stringContaining('/v1/nope'),
        docs_url: expect.stringContaining('#not_found'),
      },
    });
  });
});
