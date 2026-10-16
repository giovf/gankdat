import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// PUBLIC_BASE_URL is https://gankdat.com (wrangler.jsonc vars); every other
// test in this suite uses https://example.com, which the middleware ignores.
const fetchManual = (url: string, init?: RequestInit): Promise<Response> =>
  SELF.fetch(url, { ...init, redirect: 'manual' });

describe('canonical host', () => {
  it('301s www to the apex host, keeping path and query', async () => {
    const res = await fetchManual('https://www.gankdat.com/stats/uk-tenders?utm_source=x');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://gankdat.com/stats/uk-tenders?utm_source=x');
  });

  it('301s http to https on the canonical host', async () => {
    const res = await fetchManual('http://gankdat.com/stats');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://gankdat.com/stats');
  });

  it('301s trailing-slash variants of the stats pages', async () => {
    const index = await fetchManual('https://gankdat.com/stats/');
    expect(index.status).toBe(301);
    expect(index.headers.get('location')).toBe('https://gankdat.com/stats');
    const page = await fetchManual('https://gankdat.com/stats/uk-tenders/');
    expect(page.status).toBe(301);
    expect(page.headers.get('location')).toBe('https://gankdat.com/stats/uk-tenders');
  });

  it('keeps API paths byte-for-byte and uses 308 for non-GET requests', async () => {
    const res = await fetchManual('https://www.gankdat.com/mcp/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('https://gankdat.com/mcp/');
  });

  it('leaves the canonical origin and non-brand hosts alone', async () => {
    const canonical = await fetchManual('https://gankdat.com/stats');
    expect(canonical.status).toBe(200);
    expect(canonical.headers.get('content-type')).toContain('text/html');
    const preview = await fetchManual('http://example.com/stats/');
    expect(preview.status).not.toBe(301);
  });
});
