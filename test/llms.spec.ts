import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildQuerySchema } from '../src/sources/query';
import { listSources } from '../src/sources/registry';

describe('GET /llms.txt', () => {
  it('serves cacheable plain text generated from the registry', async () => {
    const res = await SELF.fetch('https://example.com/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    expect(await res.text()).toContain('# gankdat');
  });

  it('covers every registered source: endpoint, filters, and MCP tool — a new niche appears with zero edits', async () => {
    const text = await (await SELF.fetch('https://example.com/llms.txt')).text();
    for (const source of listSources()) {
      expect(text).toContain(`/v1/data/${source.slug}`);
      expect(text).toContain(`query_${source.slug.replaceAll('-', '_')}`);
      for (const param of Object.keys(buildQuerySchema(source).shape)) {
        expect(text).toContain(param);
      }
    }
    // Change feeds: every register dataset, the MCP tool, and nothing for snapshot sources.
    expect(text).toContain('## Change feeds');
    expect(text).toContain('get_changes');
    expect(text).toContain('/v1/changes/uk-charities');
    expect(text).not.toContain('/v1/changes/uk-planning');
    // Platform surfaces every niche shares.
    expect(text).toContain('/openapi.json');
    expect(text).toContain('/mcp');
    expect(text).toContain('x402');
  });
});
