import { SELF } from 'cloudflare:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/lib/envelope';
import { noindexWalls, ROBOTS_HEADER } from '../src/middleware/robots';
import type { AppEnv } from '../src/types';

// Search Console 2026-10-15: Googlebot reached the keyless 401/402 walls behind the
// /v1/data and /mcp links and reported them as unindexable pages. The walls stay
// crawlable (agents read their bodies) but every one of them declines indexing.
describe('noindex on the keyless walls', () => {
  it('marks the keyless REST 401 noindex and keeps WWW-Authenticate', async () => {
    const res = await SELF.fetch('https://example.com/v1/data/uk-tenders');
    expect(res.status).toBe(401);
    expect(res.headers.get(ROBOTS_HEADER)).toBe('noindex');
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
  });

  it('marks the keyless MCP 401 noindex', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get(ROBOTS_HEADER)).toBe('noindex');
  });

  it('leaves indexable pages and other statuses alone', async () => {
    const stats = await SELF.fetch('https://example.com/stats');
    expect(stats.status).toBe(200);
    expect(stats.headers.get(ROBOTS_HEADER)).toBeNull();
    const health = await SELF.fetch('https://example.com/v1/health');
    expect(health.status).toBe(200);
    expect(health.headers.get(ROBOTS_HEADER)).toBeNull();
    const missing = await SELF.fetch('https://example.com/v1/nothing-here');
    expect(missing.status).toBe(404);
    expect(missing.headers.get(ROBOTS_HEADER)).toBeNull();
  });

  it('covers a 402, a thrown 401 and a route that set its own tag', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', noindexWalls());
    app.onError(errorHandler);
    app.get('/pay', (c) => c.json({ ok: false }, 402));
    app.get('/throw', () => {
      throw new HTTPException(401, { message: 'nope' });
    });
    app.get('/own', (c) => c.json({ ok: false }, 402, { [ROBOTS_HEADER]: 'none' }));
    app.get('/raw', () => new Response('wall', { status: 402 }));

    expect((await app.request('/pay')).headers.get(ROBOTS_HEADER)).toBe('noindex');
    const thrown = await app.request('/throw');
    expect(thrown.status).toBe(401);
    expect(thrown.headers.get(ROBOTS_HEADER)).toBe('noindex');
    expect((await app.request('/own')).headers.get(ROBOTS_HEADER)).toBe('none');
    expect((await app.request('/raw')).headers.get(ROBOTS_HEADER)).toBe('noindex');
  });
});
