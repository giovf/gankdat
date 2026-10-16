import { z } from 'zod';
import { APP_VERSION } from './constants';
import { ERROR_CODES } from './envelope';
import { buildQuerySchema } from '../sources/query';
import { changeFiltersSchema } from '../routes/changes';
import { hasChangeFeed, listSources } from '../sources/registry';
import type { DataSource } from '../sources/types';

// Generator choice (task 4.1, recorded 2026-07-06): zod v4's native
// z.toJSONSchema() emits JSON Schema draft 2020-12 — the dialect OpenAPI 3.1
// is built on — so the registry-driven document needs no extra dependency and
// no OpenAPIHono route rewrite. Query params use io:'input' so coercions and
// transforms document what the client actually sends. Revisit only if we need
// features this can't express (request bodies land with tasks 6/8).

type JsonObject = Record<string, unknown>;

function toSchema(schema: z.ZodType): JsonObject {
  const generated = z.toJSONSchema(schema, { io: 'input' }) as JsonObject;
  delete generated.$schema; // fragment inside the document, not a standalone schema
  return generated;
}

const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    docs_url: z.string(),
    details: z.unknown().optional(),
  }),
});

function successEnvelope(data: z.ZodType, meta?: z.ZodType): JsonObject {
  return toSchema(
    z.object({
      ok: z.literal(true),
      data,
      ...(meta ? { meta } : {}),
    }),
  );
}

function jsonResponse(description: string, schema: JsonObject): JsonObject {
  return { description, content: { 'application/json': { schema } } };
}

function errorResponse(description: string): JsonObject {
  return jsonResponse(description, { $ref: '#/components/schemas/ErrorEnvelope' });
}

function queryParameters(source: DataSource): JsonObject[] {
  return Object.entries(buildQuerySchema(source).shape).map(([name, field]) => ({
    name,
    in: 'query',
    required: false,
    schema: toSchema(field as z.ZodType),
  }));
}

const paginationMeta = z.object({
  source: z.string(),
  page: z.int(),
  per_page: z.int(),
  total: z.int(),
  last_refreshed_at: z.string().nullable(),
});

function sourcePathItem(source: DataSource): JsonObject {
  return {
    get: {
      operationId: `query_${source.slug.replaceAll('-', '_')}`,
      summary: source.title,
      description: source.description,
      tags: ['data'],
      security: [{ bearerAuth: [] }],
      parameters: queryParameters(source),
      responses: {
        '200': jsonResponse(
          `Matching ${source.title} records`,
          successEnvelope(z.array(source.recordSchema), paginationMeta),
        ),
        '400': errorResponse('Invalid query parameters (see error.details)'),
        '401': errorResponse('Missing, unknown, or revoked API key'),
        '402': errorResponse('Monthly credit quota exhausted (code: quota_exceeded)'),
        '429': errorResponse('Rate limit exceeded (see Retry-After header)'),
        '503': errorResponse('Source temporarily unavailable, retry later'),
      },
    },
  };
}

const billingPaths: JsonObject = {
  '/v1/billing/checkout': {
    post: {
      operationId: 'create_checkout',
      summary: 'Create a Stripe Checkout session for a paid plan',
      tags: ['platform'],
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: toSchema(z.object({ plan: z.string() })) },
        },
      },
      responses: {
        '200': jsonResponse(
          'Checkout session created',
          successEnvelope(z.object({ url: z.string().nullable(), plan: z.string() })),
        ),
        '400': errorResponse('Unknown plan'),
        '401': errorResponse('Missing, unknown, or revoked API key'),
        '503': errorResponse('Billing not configured'),
      },
    },
  },
  '/v1/billing/paypal/orders': {
    post: {
      operationId: 'create_paypal_order',
      summary: 'Buy a one-off credit pack with PayPal (sandbox): returns the approval URL',
      description:
        'Credit packs (pack_1k, pack_5k, pack_20k; GET /v1/billing/paypal/packs lists them) add to a top-up balance spent once the monthly plan allowance is gone; they never expire. The order is captured when the buyer returns from PayPal, or by POST /v1/billing/paypal/orders/{id}/capture. PayPal sandbox only — no live money moves.',
      tags: ['platform'],
      security: [{ bearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: toSchema(z.object({ pack: z.string() })) },
        },
      },
      responses: {
        '200': jsonResponse(
          'Order created; the buyer approves at approve_url',
          successEnvelope(
            z.object({
              order_id: z.string(),
              approve_url: z.string(),
              pack: z.string(),
              credits: z.int(),
              amount_usd: z.string(),
              next: z.string(),
            }),
          ),
        ),
        '400': errorResponse('Unknown pack'),
        '401': errorResponse('Missing, unknown, or revoked API key'),
        '503': errorResponse('Credit packs not configured, or PayPal unavailable'),
      },
    },
  },
  '/v1/billing/paypal/orders/{id}/capture': {
    post: {
      operationId: 'capture_paypal_order',
      summary: 'Capture an approved PayPal order and add its credits (idempotent)',
      tags: ['platform'],
      security: [{ bearerAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          description: 'The order_id from create_paypal_order',
        },
      ],
      responses: {
        '200': jsonResponse(
          'Order captured (status completed) or already captured (already_completed)',
          successEnvelope(
            z.object({
              order_id: z.string(),
              status: z.enum(['completed', 'already_completed']),
              credits_added: z.int(),
              topup: z.int(),
            }),
          ),
        ),
        '401': errorResponse('Missing, unknown, or revoked API key'),
        '404': errorResponse('No such order on this account'),
        '409': errorResponse('The buyer has not approved the order yet (code: payment_required)'),
        '503': errorResponse('Credit packs not configured, or PayPal unavailable'),
      },
    },
  },
  '/v1/billing/portal': {
    get: {
      operationId: 'billing_portal',
      summary: 'Get a Stripe customer-portal link (manage/cancel subscription)',
      tags: ['platform'],
      security: [{ bearerAuth: [] }],
      responses: {
        '200': jsonResponse('Portal link', successEnvelope(z.object({ url: z.string() }))),
        '401': errorResponse('Missing, unknown, or revoked API key'),
        '404': errorResponse('No billing account for this key'),
        '503': errorResponse('Billing not configured'),
      },
    },
  },
};

const waitlistPath: JsonObject = {
  '/v1/waitlist': {
    post: {
      operationId: 'join_waitlist',
      summary: 'Join the launch waitlist (email only, GDPR-minimal)',
      tags: ['platform'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: toSchema(z.object({ email: z.email(), source: z.string().optional() })),
          },
        },
      },
      responses: {
        '200': jsonResponse(
          'Subscribed (idempotent)',
          successEnvelope(z.object({ subscribed: z.boolean() })),
        ),
        '400': errorResponse('Invalid request body'),
        '429': errorResponse('Rate limit exceeded'),
      },
    },
  },
};

const feedbackPath: JsonObject = {
  '/v1/feedback': {
    post: {
      operationId: 'send_feedback',
      summary: 'Send product feedback (public; email optional, only for replies)',
      tags: ['platform'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: toSchema(
              z.object({
                message: z.string().min(3).max(2000),
                email: z.email().optional(),
                page: z.string().max(200).optional(),
              }),
            ),
          },
        },
      },
      responses: {
        '200': jsonResponse(
          'Feedback stored',
          successEnvelope(z.object({ received: z.boolean() })),
        ),
        '400': errorResponse('Invalid request body'),
        '429': errorResponse('Rate limit exceeded'),
      },
    },
  },
};

const usagePath: JsonObject = {
  '/v1/usage': {
    get: {
      operationId: 'get_usage',
      summary: 'Current-period credit usage for the presented key (free to call)',
      tags: ['platform'],
      security: [{ bearerAuth: [] }],
      responses: {
        '200': jsonResponse(
          'Usage summary',
          successEnvelope(
            z.object({
              plan: z.string(),
              period: z.string(),
              used: z.number(),
              granted: z.number(),
              remaining: z.number(),
              alerts: z.array(z.string()),
            }),
          ),
        ),
        '401': errorResponse('Missing, unknown, or revoked API key'),
      },
    },
  },
};

const keysPaths: JsonObject = {
  // Key CREATION is deliberately absent from the public API: it requires a
  // signed-in session (email magic link at /account), because keys inherit the
  // account's plan and issuance against unverified emails would leak it.
  '/v1/keys': {
    delete: {
      operationId: 'revoke_key',
      summary: 'Revoke the presented API key (self-serve)',
      tags: ['platform'],
      security: [{ bearerAuth: [] }],
      responses: {
        '200': jsonResponse('Key revoked', successEnvelope(z.object({ revoked: z.boolean() }))),
        '401': errorResponse('Missing, unknown, or revoked API key'),
      },
    },
  },
};

const sourceListingSchema = z.array(
  z.object({
    slug: z.string(),
    title: z.string(),
    description: z.string(),
    supported_params: z.array(z.string()),
    refresh_cron: z.string(),
    credit_cost: z.number(),
    change_feed: z
      .string()
      .nullable()
      .describe('Path of the daily change feed (register datasets), else null'),
    notice: z
      .string()
      .nullable()
      .describe(
        'A dated note while the origin is paused or emptied (last snapshot served), else null',
      ),
  }),
);

const changeRowSchema = z.object({
  change: z.enum(['added', 'removed', 'changed']),
  changed_at: z.string(),
  record_id: z.string(),
  record: z.record(z.string(), z.unknown()),
});

function changesPathItem(source: DataSource): JsonObject {
  const filters = Object.entries(changeFiltersSchema(source).shape).map(([name, field]) => ({
    name,
    in: 'query',
    required: false,
    schema: toSchema(field as z.ZodType),
    description: `Filter the changed record like /v1/data/${source.slug}?${name}=…`,
  }));
  return {
    get: {
      operationId: `changes_${source.slug.replaceAll('-', '_')}`,
      summary: `${source.title} — changes since a date`,
      description: `Rows added, removed or changed in ${source.title} between daily refreshes, newest first (90-day history). Poll this instead of re-reading the whole register. Takes the same filters as /v1/data/${source.slug}, applied to the changed record, so one call is a watch. Costs the same credits as a query.`,
      tags: ['changes'],
      security: [{ bearerAuth: [] }],
      parameters: [
        ...filters,
        {
          name: 'since',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date' },
          description:
            'Only changes observed at or after this date (YYYY-MM-DD). Default: 7 days ago.',
        },
        {
          name: 'change',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['added', 'removed', 'changed'] },
        },
        {
          name: 'page',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, default: 1 },
        },
        {
          name: 'per_page',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        },
      ],
      responses: {
        '200': jsonResponse(
          `Changes to ${source.title}`,
          successEnvelope(z.array(changeRowSchema), paginationMeta),
        ),
        '400': errorResponse('Invalid query parameters (see error.details)'),
        '401': errorResponse('Missing, unknown, or revoked API key'),
        '402': errorResponse('Monthly credit quota exhausted (code: quota_exceeded)'),
        '404': errorResponse('Source has no change feed'),
        '429': errorResponse('Rate limit exceeded (see Retry-After header)'),
      },
    },
  };
}

function buildDocument(baseUrl: string): JsonObject {
  const sourcePaths = Object.fromEntries([
    ...listSources().map((source) => [`/v1/data/${source.slug}`, sourcePathItem(source)]),
    ...listSources()
      .filter(hasChangeFeed)
      .map((source) => [`/v1/changes/${source.slug}`, changesPathItem(source)]),
  ]);

  // Registry-derived so a new/renamed niche updates the served spec automatically.
  const catalog = listSources()
    .map((source) => source.title)
    .join(', ');

  return {
    openapi: '3.1.0',
    info: {
      title: 'gankdat',
      version: APP_VERSION,
      description:
        `Clean-JSON access to ${catalog} — one schema across every dataset, from ` +
        'official open-data feeds. Built for developers and AI agents (native MCP + x402). ' +
        'Licence and personal-data posture are stated per dataset in the terms ' +
        '(OGL v3 sources; Blind Mode where stated).',
      // Directory importers (RapidAPI et al.) and spec crawlers read these.
      contact: { name: 'gankdat', url: baseUrl },
      termsOfService: `${baseUrl}/terms`,
    },
    externalDocs: {
      description: 'Quickstart, interactive reference, llms.txt',
      url: `${baseUrl}/docs`,
    },
    servers: [{ url: baseUrl, description: 'Production' }],
    tags: [
      { name: 'platform', description: 'Health and discovery' },
      { name: 'data', description: 'Dataset query endpoints' },
      { name: 'changes', description: 'What changed since a date (register datasets)' },
    ],
    paths: {
      '/v1/health': {
        get: {
          operationId: 'health',
          summary: 'Liveness check',
          tags: ['platform'],
          responses: {
            '200': jsonResponse(
              'Service is up',
              successEnvelope(z.object({ status: z.string(), version: z.string() })),
            ),
          },
        },
      },
      '/v1/data': {
        get: {
          operationId: 'list_sources',
          summary: 'List available data sources',
          tags: ['platform'],
          responses: {
            '200': jsonResponse('Registered sources', successEnvelope(sourceListingSchema)),
          },
        },
      },
      ...keysPaths,
      ...usagePath,
      ...billingPaths,
      ...waitlistPath,
      ...feedbackPath,
      ...sourcePaths,
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'API key created from your account dashboard (sign in at /account), sent as a bearer token.',
        },
      },
      schemas: {
        ErrorEnvelope: toSchema(errorEnvelopeSchema),
      },
    },
  };
}

let cachedDocument: JsonObject | undefined;

/** Registry + base URL are static per deployment, so the document is built once. */
export function getOpenApiDocument(baseUrl: string): JsonObject {
  cachedDocument ??= buildDocument(baseUrl);
  return cachedDocument;
}
