import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listSources } from '../src/sources/registry';

type OpenApiDocument = {
  openapi: string;
  info: { contact?: { url?: string }; termsOfService?: string };
  externalDocs?: { url?: string };
  paths: Record<
    string,
    { get?: { parameters?: { name: string; schema: { type?: string; format?: string } }[] } }
  >;
  components: {
    securitySchemes: Record<string, { type: string; scheme?: string }>;
    schemas: Record<string, { properties?: Record<string, unknown> }>;
  };
};

async function fetchDocument(): Promise<{ res: Response; doc: OpenApiDocument }> {
  const res = await SELF.fetch('https://example.com/openapi.json');
  return { res, doc: (await res.json()) as OpenApiDocument };
}

describe('GET /openapi.json', () => {
  it('serves a cacheable OpenAPI 3.1 document', async () => {
    const { res, doc } = await fetchDocument();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    expect(doc.openapi).toMatch(/^3\.1\./);
  });

  it('carries discovery metadata for spec crawlers and directory importers', async () => {
    const { doc } = await fetchDocument();
    expect(doc.info.contact?.url).toBeTruthy();
    expect(doc.info.termsOfService).toContain('/terms');
    expect(doc.externalDocs?.url).toContain('/docs');
  });

  it('has a path for every registered source, generated from the registry', async () => {
    const { doc } = await fetchDocument();
    for (const source of listSources()) {
      expect(doc.paths[`/v1/data/${source.slug}`]?.get).toBeDefined();
    }
    expect(doc.paths['/v1/health']?.get).toBeDefined();
    expect(doc.paths['/v1/data']?.get).toBeDefined();
  });

  it('documents query params matching the source queryParams shape', async () => {
    const { doc } = await fetchDocument();
    const params = doc.paths['/v1/data/uk-planning']?.get?.parameters ?? [];
    const byName = new Map(params.map((p) => [p.name, p.schema]));
    expect([...byName.keys()].sort()).toEqual(
      [
        'authority',
        'decision_date_after',
        'decision_date_before',
        'page',
        'per_page',
        'q',
        'reference',
      ].sort(),
    );
    expect(byName.get('authority')?.type).toBe('number');
    expect(byName.get('decision_date_after')?.format).toBe('date');
    expect(byName.get('page')?.type).toBe('integer');
  });

  it('declares the bearer security scheme and the error envelope schema', async () => {
    const { doc } = await fetchDocument();
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    const errorSchema = doc.components.schemas.ErrorEnvelope;
    expect(errorSchema?.properties).toHaveProperty('error');
  });
});
