import { z } from 'zod';
import type { RouteConfig } from '@x402/core/server';
import type { DeclareDiscoveryExtensionInput } from '@x402/extensions/bazaar';
import { failure } from '../lib/envelope';
import { buildQuerySchema } from '../sources/query';
import { listSources } from '../sources/registry';
import type { DataSource } from '../sources/types';

// x402 v2 route configuration for the pay-per-call lane, with the Bazaar discovery
// metadata the CDP catalogue indexes (gankdat `x402-bazaar-listing`, 2026-10-14).
//
// Everything here is generated from the source registry — the same zod schemas that
// build the REST validation, the OpenAPI document and the MCP tools — so a new dataset
// is discoverable the day it ships and nothing dataset-specific lives in this file.
// Only type imports from the x402 packages: the runtime modules (and viem beneath
// them) load lazily in routes.ts on the first lit request, as before.
//
// Content policy (docs.cdp.coinbase.com/x402/seller/get-discovered, read 2026-10-14):
// metadata describes the endpoint and is never worded as an instruction to an agent —
// the catalogue screens every resource before and after indexing and drops the ones
// that read like prompts. Keep descriptions declarative.

/** x402 network names accepted in X402_NETWORK, mapped to the CAIP-2 ids x402 v2 uses. */
export const X402_NETWORKS = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
} as const;
export type X402NetworkName = keyof typeof X402_NETWORKS;

export function isX402Network(value: string): value is X402NetworkName {
  return Object.hasOwn(X402_NETWORKS, value);
}

/** Operator configuration of the lane, read from env at request time. */
export interface X402Lane {
  /** Public origin the resources are listed under, e.g. https://gankdat.com. */
  baseUrl: string;
  /** Receiving wallet (X402_WALLET_ADDRESS). */
  payTo: string;
  /** Platform price per call, e.g. '$0.005'; a source's x402PriceUsd overrides it. */
  price: string;
  network: X402NetworkName;
}

/** `declareDiscoveryExtension` from @x402/extensions/bazaar, injected so this module stays import-free. */
export type DeclareDiscovery = (config: DeclareDiscoveryExtensionInput) => Record<string, unknown>;

export const X402_SERVICE_NAME = 'gankdat';
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 32;
const BASE_TAGS = ['official-data', 'public-register'];

export function x402Path(slug: string): string {
  return `/x402/data/${slug}`;
}

/** Route key the x402 middleware matches: method + absolute path. */
export function x402RouteKey(slug: string): string {
  return `GET ${x402Path(slug)}`;
}

const DESCRIPTION_BUDGET = 420;

/** Whole sentences of the text that fit the budget — at least the first one. */
export function leadingSentences(text: string, budget = DESCRIPTION_BUDGET): string {
  const sentences =
    text
      .replace(/\s+/g, ' ')
      .trim()
      .match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [];
  let out = '';
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence.trim()}` : sentence.trim();
    if (out && next.length > budget) break;
    out = next;
  }
  return out;
}

/**
 * The CDP facilitator rejects verify and settle when the resource description exceeds 500
 * characters (seller docs, read 2026-10-23) — so a longer description is not a listing problem
 * but a route that can never take a payment: 13 of 17 routes were over it from v0.25.0 to
 * v0.25.3, and the 2026-10-23 probe round settled only on the two under it.
 */
export const DESCRIPTION_MAX = 500;

/**
 * The plain, declarative description the catalogue shows agents deciding whether to call:
 * the source's own one-liner cut to whole sentences (the registry descriptions run to 600+
 * chars for the large registers; a catalogue card reads at ~400) plus what one call returns,
 * never longer than `DESCRIPTION_MAX` in all.
 */
export function bazaarDescription(source: DataSource): string {
  const shape = source.lookup
    ? 'One call returns one record as JSON.'
    : 'One call returns one page of matching records as JSON (25 by default, per_page up to 100) with the total count and the last refresh time; the query parameters filter the records.';
  const head = `${source.title}.`;
  const budget = Math.min(DESCRIPTION_BUDGET, DESCRIPTION_MAX - head.length - shape.length - 2);
  const summary = leadingSentences(source.description, budget);
  const full = `${head} ${summary} ${shape}`;
  if (full.length <= DESCRIPTION_MAX) return full;
  // the first sentence alone is over budget: the title and the shape still describe the call
  return `${head} ${shape}`.slice(0, DESCRIPTION_MAX);
}

/** ≤ 5 short tags: two shared ones plus the slug's words (the catalogue drops anything longer). */
export function bazaarTags(source: DataSource): string[] {
  const tags: string[] = [];
  for (const tag of [...BASE_TAGS, ...source.slug.split('-')]) {
    if (tag.length === 0 || tag.length > MAX_TAG_LENGTH || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

type JsonObject = Record<string, unknown>;

/**
 * Example query an agent could send as-is: the lookup key for a lookup source, else a small page.
 * Each value carries the type the input schema declares for it (CDP's validator checks the example
 * against our own schema: `per_page: '5'` under an integer property failed every route's `parse`
 * preflight with "Expected: integer, given: string" on 2026-10-14 — relay relay-post-proof).
 */
export function bazaarExampleInput(source: DataSource): Record<string, string | number | boolean> {
  const raw: Record<string, string> = source.lookup
    ? { ...source.lookup.example }
    : { per_page: '5' };
  const properties = (bazaarInputSchema(source).properties ?? {}) as Record<string, JsonObject>;
  const typed: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    const declared = properties[key]?.type;
    const type = Array.isArray(declared) ? declared.find((t) => t !== 'null') : declared;
    if ((type === 'integer' || type === 'number') && /^-?\d+(\.\d+)?$/.test(value)) {
      typed[key] = Number(value);
    } else if (type === 'boolean' && (value === 'true' || value === 'false')) {
      typed[key] = value === 'true';
    } else {
      typed[key] = value;
    }
  }
  return typed;
}

/** JSON Schema of the query parameters (filters + page, per_page, q), as the OpenAPI document states them. */
export function bazaarInputSchema(source: DataSource): JsonObject {
  const generated = z.toJSONSchema(buildQuerySchema(source), { io: 'input' }) as JsonObject;
  const schema: JsonObject = { properties: generated.properties ?? {} };
  if (source.lookup) {
    // At least one key identifies the record; the route answers 400 naming them otherwise.
    schema.anyOf = source.lookup.keys.map((key) => ({ required: [key] }));
  }
  return schema;
}

/**
 * A representative value for a JSON Schema node — the shape agents see before paying.
 * Deterministic and type-honest (dates look like dates, enums use their first member);
 * a live page-1 read would cost 17 store reads on the lane's first request and still be
 * stale by the next morning, so the example is derived from the record schema instead.
 */
export function exampleFromSchema(node: unknown, depth = 0): unknown {
  if (!node || typeof node !== 'object') return null;
  const schema = node as JsonObject;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  const options = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(options) && options.length > 0) {
    const nonNull = options.find((o) => (o as JsonObject | null)?.type !== 'null') ?? options[0];
    return exampleFromSchema(nonNull, depth);
  }
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== 'null')
    : schema.type;
  switch (type) {
    case 'object': {
      const out: JsonObject = {};
      for (const [key, child] of Object.entries((schema.properties as JsonObject) ?? {})) {
        out[key] = depth > 4 ? null : exampleFromSchema(child, depth + 1);
      }
      return out;
    }
    case 'array':
      return depth > 3 ? [] : [exampleFromSchema(schema.items, depth + 1)];
    case 'string':
      switch (schema.format) {
        case 'date':
          return '2026-01-15';
        case 'date-time':
          return '2026-01-15T09:00:00.000Z';
        case 'email':
          return 'name@example.org';
        case 'uri':
        case 'url':
          return 'https://example.org';
        default:
          return 'text';
      }
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

const pageMeta = z.object({
  source: z.string(),
  page: z.int(),
  per_page: z.int(),
  total: z.int(),
  last_refreshed_at: z.string().nullable(),
});

function envelopeSchema(source: DataSource): z.ZodType {
  return z.object({
    ok: z.literal(true),
    data: z.array(source.recordSchema),
    meta: pageMeta,
  });
}

/** Example success envelope: one schema-derived record under the real meta fields. */
export function bazaarOutputExample(source: DataSource): JsonObject {
  const record = exampleFromSchema(
    z.toJSONSchema(source.recordSchema, { io: 'output', unrepresentable: 'any' }),
  );
  return {
    ok: true,
    data: [record],
    meta: {
      source: source.slug,
      page: 1,
      per_page: source.lookup ? 1 : 25,
      total: 1,
      last_refreshed_at: '2026-01-15T05:15:00.000Z',
    },
  };
}

/** JSON Schema of the success envelope (`output.schema` in the declaration). */
export function bazaarOutputSchema(source: DataSource): JsonObject {
  const generated = z.toJSONSchema(envelopeSchema(source), {
    io: 'output',
    unrepresentable: 'any',
  }) as JsonObject;
  delete generated.$schema;
  return generated;
}

/** The lane's unpaid 402 body: the usual error envelope, so every client reads the same shape. */
export function unpaidBody(): { contentType: string; body: unknown } {
  return {
    contentType: 'application/json',
    body: failure(
      'payment_required',
      'This route is paid per call with x402 (USDC on Base, no account): the PAYMENT-REQUIRED header carries the price, network and receiving address. Keyed access without x402 is at /v1/data.',
    ),
  };
}

/** One x402 v2 route with its Bazaar declaration, built from the registry entry. */
export function bazaarRoute(
  source: DataSource,
  lane: X402Lane,
  declare: DeclareDiscovery,
): RouteConfig {
  return {
    accepts: {
      scheme: 'exact',
      payTo: lane.payTo,
      price: source.x402PriceUsd || lane.price,
      network: X402_NETWORKS[lane.network],
      maxTimeoutSeconds: 300,
    },
    resource: `${lane.baseUrl}${x402Path(source.slug)}`,
    description: bazaarDescription(source),
    mimeType: 'application/json',
    serviceName: X402_SERVICE_NAME,
    tags: bazaarTags(source),
    unpaidResponseBody: () => unpaidBody(),
    // The route key's verb (GET) is stamped into info.input.method by the Bazaar server
    // extension at request time; the declaration itself carries no method.
    extensions: declare({
      input: bazaarExampleInput(source),
      inputSchema: bazaarInputSchema(source),
      output: { example: bazaarOutputExample(source), schema: bazaarOutputSchema(source) },
    }),
  };
}

/** Every registered source as `GET /x402/data/<slug>` → route config. */
export function bazaarRoutes(
  lane: X402Lane,
  declare: DeclareDiscovery,
): Record<string, RouteConfig> {
  return Object.fromEntries(
    listSources().map((source) => [x402RouteKey(source.slug), bazaarRoute(source, lane, declare)]),
  );
}
