import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { errorHandler, notFoundHandler, statusToCode, success } from '../src/lib/envelope';
import type { ErrorEnvelope } from '../src/lib/envelope';
import type { AppEnv } from '../src/types';

function scratchApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/unauthorized', () => {
    throw new HTTPException(401, { message: 'Missing API key' });
  });
  app.get('/crash', () => {
    throw new Error('secret internal detail');
  });
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps HTTPException status to a stable code and keeps the message', async () => {
    const res = await scratchApp().request('/unauthorized');
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('unauthorized');
    expect(body.error.message).toBe('Missing API key');
    expect(body.error.docs_url).toContain('#unauthorized');
  });

  it('hides internal details on unexpected errors', async () => {
    const res = await scratchApp().request('/crash');
    expect(res.status).toBe(500);
    const body = (await res.json()) as ErrorEnvelope;
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
  });
});

describe('statusToCode', () => {
  it('maps known statuses and falls back to internal', () => {
    expect(statusToCode(400)).toBe('bad_request');
    expect(statusToCode(402)).toBe('payment_required');
    expect(statusToCode(429)).toBe('rate_limited');
    expect(statusToCode(503)).toBe('unavailable');
    expect(statusToCode(418)).toBe('internal');
  });
});

describe('success', () => {
  it('omits meta when not provided', () => {
    expect(success({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
    expect(success({ a: 1 }, { page: 2 })).toEqual({ ok: true, data: { a: 1 }, meta: { page: 2 } });
  });
});
