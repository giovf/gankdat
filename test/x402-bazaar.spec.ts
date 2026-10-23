import { declareDiscoveryExtension, validateBazaarRouteExtensions } from '@x402/extensions/bazaar';
import { describe, expect, it } from 'vitest';
import { listSources } from '../src/sources/registry';
import {
  DESCRIPTION_MAX,
  bazaarDescription,
  bazaarExampleInput,
  bazaarInputSchema,
  bazaarOutputExample,
  bazaarRoute,
  bazaarRoutes,
  bazaarTags,
  exampleFromSchema,
  type X402Lane,
} from '../src/x402/bazaar';

// Pure tests of the Bazaar declarations: no worker, no facilitator. The catalogue reads
// exactly this metadata, so what the library's own validator accepts and what the content
// policy forbids (text that instructs an agent) are both checked here, for every source.

const LANE: X402Lane = {
  baseUrl: 'https://gankdat.com',
  payTo: '0x1111111111111111111111111111111111111111',
  price: '$0.005',
  network: 'base',
};

describe('x402 Bazaar declarations', () => {
  const routes = bazaarRoutes(LANE, declareDiscoveryExtension);

  it('declares one GET route per registered source under the public base URL', () => {
    const sources = listSources();
    expect(Object.keys(routes)).toHaveLength(sources.length);
    for (const source of sources) {
      const route = routes[`GET /x402/data/${source.slug}`];
      expect(route, source.slug).toBeDefined();
      expect(route!.resource).toBe(`https://gankdat.com/x402/data/${source.slug}`);
      expect(route!.serviceName).toBe('gankdat');
      expect(route!.mimeType).toBe('application/json');
    }
  });

  it("passes the x402 library's own Bazaar route validation", () => {
    expect(() => validateBazaarRouteExtensions(routes)).not.toThrow();
  });

  it('prices each route from the platform price unless the source sets its own', () => {
    const planning = routes['GET /x402/data/uk-planning']!.accepts;
    const lookup = routes['GET /x402/data/uk-company-profiles']!.accepts;
    expect(Array.isArray(planning) ? planning[0] : planning).toMatchObject({
      scheme: 'exact',
      network: 'eip155:8453',
      price: '$0.005',
      payTo: LANE.payTo,
    });
    expect(Array.isArray(lookup) ? lookup[0] : lookup).toMatchObject({ price: '$0.01' });
  });

  it('describes every endpoint declaratively — never as an instruction to an agent', () => {
    for (const source of listSources()) {
      const description = bazaarDescription(source);
      expect(description.startsWith(`${source.title}.`), source.slug).toBe(true);
      // Content policy: no second person, no imperatives aimed at the reader.
      expect(description, source.slug).not.toMatch(/\b(you|your|please|must|ignore|always)\b/i);
      expect(description, source.slug).not.toMatch(/\b(use|call|try|send|pass) (this|it)\b/i);
      // the CDP facilitator rejects verify/settle above 500 chars: 13 routes were unpayable until 10-23
      expect(description.length, source.slug).toBeLessThanOrEqual(DESCRIPTION_MAX);
    }
  });

  it('keeps tags to the catalogue limits (≤ 5, each ≤ 32 printable chars)', () => {
    for (const source of listSources()) {
      const tags = bazaarTags(source);
      expect(tags.length, source.slug).toBeGreaterThan(0);
      expect(tags.length, source.slug).toBeLessThanOrEqual(5);
      for (const tag of tags) expect(tag, source.slug).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(new Set(tags).size).toBe(tags.length);
    }
    expect(bazaarTags(listSources()[0]!)).toContain('official-data');
  });

  it('builds the input schema from the source params plus the platform paging params', () => {
    const planning = listSources().find((s) => s.slug === 'uk-planning')!;
    const schema = bazaarInputSchema(planning) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['authority', 'reference', 'page', 'per_page', 'q']),
    );
    const lookup = listSources().find((s) => s.slug === 'uk-company-profiles')!;
    const lookupSchema = bazaarInputSchema(lookup) as { anyOf: { required: string[] }[] };
    expect(lookupSchema.anyOf).toEqual([
      { required: ['company_number'] },
      { required: ['company'] },
    ]);
  });

  it('types every example query value as the input schema declares it (CDP validate rejected strings)', () => {
    for (const source of listSources()) {
      const example = bazaarExampleInput(source);
      const schema = bazaarInputSchema(source) as {
        properties: Record<string, { type?: unknown }>;
      };
      expect(Object.keys(example).length, source.slug).toBeGreaterThan(0);
      for (const [key, value] of Object.entries(example)) {
        const declared = schema.properties[key]?.type;
        const type = Array.isArray(declared) ? declared.find((t) => t !== 'null') : declared;
        expect(type, `${source.slug}.${key} is in the schema`).toBeDefined();
        if (type === 'integer') expect(Number.isInteger(value), `${source.slug}.${key}`).toBe(true);
        else if (type === 'number') expect(typeof value, `${source.slug}.${key}`).toBe('number');
        else if (type === 'boolean') expect(typeof value, `${source.slug}.${key}`).toBe('boolean');
        else expect(typeof value, `${source.slug}.${key}`).toBe('string');
      }
    }
    const page = listSources().find((s) => !s.lookup)!;
    expect(bazaarExampleInput(page)).toEqual({ per_page: 5 });
  });

  it('gives each source a schema-shaped output example that its record schema accepts', () => {
    for (const source of listSources()) {
      const example = bazaarOutputExample(source) as { ok: boolean; data: unknown[] };
      expect(example.ok).toBe(true);
      expect(example.data).toHaveLength(1);
      const parsed = source.recordSchema.safeParse(example.data[0]);
      expect(parsed.success, `${source.slug}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('keeps every payment-required document small enough for a response header', () => {
    // The whole declaration travels base64-encoded in PAYMENT-REQUIRED on every 402.
    for (const source of listSources()) {
      const route = bazaarRoute(source, LANE, declareDiscoveryExtension);
      const bytes = new TextEncoder().encode(JSON.stringify(route)).length;
      // 3–7.4 KB on 2026-10-14 (uk-company-profiles the largest); base64 adds a third.
      expect(bytes, `${source.slug}: ${bytes} bytes`).toBeLessThan(12_000);
    }
  });

  it('derives representative examples from JSON Schema nodes', () => {
    expect(exampleFromSchema({ type: 'string', format: 'date' })).toBe('2026-01-15');
    expect(exampleFromSchema({ type: 'string', enum: ['Entity', 'Individual'] })).toBe('Entity');
    expect(exampleFromSchema({ type: ['number', 'null'] })).toBe(0);
    expect(exampleFromSchema({ anyOf: [{ type: 'null' }, { type: 'boolean' }] })).toBe(false);
    expect(exampleFromSchema({ type: 'array', items: { type: 'string' } })).toEqual(['text']);
    expect(
      exampleFromSchema({
        type: 'object',
        properties: { id: { type: 'integer', minimum: 1 }, name: { type: 'string' } },
      }),
    ).toEqual({ id: 1, name: 'text' });
  });
});
