import { z } from 'zod';
import { API_BASE_URL, APP_VERSION } from '../lib/constants';
import { changeRowSchema, paginationMeta, sourceListingSchema } from '../lib/openapi';
import { changeFiltersSchema, changesQuerySchema } from '../routes/changes';
import { buildQuerySchema } from '../sources/query';
import { hasChangeFeed, listSources } from '../sources/registry';
import type { DataSource } from '../sources/types';

// Microsoft Power Platform certified-connector package, rendered from the source registry
// (gankdat `power-platform-certified-connector`, 2026-10-25; spike
// docs/exchange/spikes/power-platform-connector-shelf.md). The connector is the API surface
// a third time over — REST validation, the OpenAPI 3.1 document and the MCP tools already
// derive from the same zod schemas — emitted as the shape the connector platform takes:
// Swagger 2.0 ("the connectors' extended standard"), one action per dataset, one per change
// feed, the sources listing and the usage read, every response typed from the record schema
// (Microsoft rejects dynamic outputs), the bearer key as the one connection parameter.
//
// Rules pinned here come from Microsoft Learn's "Prepare connector files for certification"
// (read through the relay 2026-10-25, docs/relay/responses/power-platform-connector-shelf/3):
// title ≤ 30 chars without "API" or "Connector"; description 30–500 chars; operation and
// parameter summaries ≤ 80 chars of letters, digits, spaces and parentheses; descriptions full
// sentences ending in punctuation; exact response schemas, no default responses, no empty
// operations or schemas; every operation carries a visibility. test/connector.spec.ts checks
// the rendered package against each of them for every source, so a new dataset ships inside
// the rules or fails the gate.
//
// Pure functions only (no node builtins): the Workers-pool test imports this module and
// `scripts/connector.mjs` writes its output to ventures/gankdat/connector/.

type JsonObject = Record<string, unknown>;

export const CONNECTOR_TITLE = 'gankdat';
export const CONNECTOR_HOST = new URL(API_BASE_URL).host;
/** Landing background (`--bg` in public/index.html); the icon's canvas and `iconBrandColor`. */
export const ICON_BRAND_COLOR = '#0a0a0a';
export const CONNECTOR_CATEGORIES = 'Data;Business Intelligence';
export const TITLE_MAX = 30;
export const SUMMARY_MAX = 80;
export const DESCRIPTION_MIN = 30;
export const DESCRIPTION_MAX = 500;
/** Product names Microsoft bans from the title, the description and every summary and description. */
export const PRODUCT_NAMES = [
  'Copilot Studio',
  'Power Apps',
  'Power Automate',
  'Power Platform',
  'Logic Apps',
];
/** Words the title alone must not contain, on top of the product names. */
export const TITLE_BANNED_WORDS = ['API', 'Connector', ...PRODUCT_NAMES];

export const CONNECTOR_DESCRIPTION =
  'UK and EU public registers as clean JSON: company lookup and monitoring, tenders and contract ' +
  'awards, sanctions and exclusions, charities, schools, NHS organisations, care locations, trade ' +
  'marks and licences. One schema across every dataset, from official open-data feeds, with a ' +
  'daily change feed on each register. Connect with the key from your gankdat account.';

export const KEY_INSTRUCTION =
  "Your gankdat key, entered as 'Bearer yourKey' (create one at https://gankdat.com/account).";

// ── text helpers ──────────────────────────────────────────────────────────────

/** Letters, digits, spaces and parentheses only, ≤ SUMMARY_MAX, cut at a word. */
export function summaryText(text: string, max = SUMMARY_MAX): string {
  const clean = text
    .replace(/&/g, ' and ')
    .replace(/[^A-Za-z0-9() ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const atWord = cut.lastIndexOf(' ');
  return (atWord > max / 2 ? cut.slice(0, atWord) : cut).trim();
}

/** `value_amount_min` → `Value amount min`. */
export function words(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A full sentence: ends with ., ! or ?. */
export function sentence(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed === '') return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Whole sentences of `text` within `budget` characters — at least the first one. */
export function leadingSentences(text: string, budget: number): string {
  const sentences =
    text
      .replace(/\s+/g, ' ')
      .trim()
      .match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [];
  let out = '';
  for (const part of sentences) {
    const next = out ? `${out} ${part.trim()}` : part.trim();
    if (out && next.length > budget) break;
    out = next;
  }
  return out;
}

export function operationId(prefix: string, slug: string): string {
  return `${prefix}_${slug.replaceAll('-', '_')}`;
}

// ── JSON Schema 2020-12 (zod) → Swagger 2.0 schema ────────────────────────────

const SAFE_BOUND = Number.MAX_SAFE_INTEGER;

function firstType(node: JsonObject): { type: string | undefined; nullable: boolean } {
  const declared = node.type;
  if (Array.isArray(declared)) {
    const types = declared as string[];
    return { type: types.find((t) => t !== 'null'), nullable: types.includes('null') };
  }
  if (typeof declared === 'string') return { type: declared, nullable: declared === 'null' };
  return { type: undefined, nullable: false };
}

/**
 * Swagger 2.0 has no unions, no `const`, no `type: [..]`, no numeric `exclusiveMinimum`:
 * nullable types become `x-nullable`, a union stands for its first non-null branch (the
 * registry's unions are all `T | null`), `const` becomes a one-member `enum`, the ±2^53
 * bounds zod puts on integers are dropped. Every object property gets an `x-ms-summary`
 * and a description (the schema's own, else one made from the key), as the certification
 * rules ask. An untyped node throws — Microsoft rejects empty schemas, so a `z.unknown()`
 * in a record schema is a build error here, never a silent gap.
 */
export function toSwaggerSchema(node: unknown, path = '$'): JsonObject {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    throw new Error(`connector: no schema at ${path}`);
  }
  const schema = node as JsonObject;
  const options = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(options) && options.length > 0) {
    const nonNull = options.filter((o) => (o as JsonObject | null)?.type !== 'null');
    const chosen = toSwaggerSchema(nonNull[0] ?? options[0], `${path}.anyOf[0]`);
    if (nonNull.length < options.length) chosen['x-nullable'] = true;
    if (typeof schema.description === 'string') chosen.description ??= schema.description;
    return chosen;
  }

  const first = firstType(schema);
  const nullable = first.nullable;
  let type = first.type;
  if (type === undefined && schema.const !== undefined) type = typeof schema.const;
  if (type === undefined && Array.isArray(schema.enum) && schema.enum.length > 0) {
    type = typeof schema.enum[0];
  }
  if (type === undefined && schema.properties !== undefined) type = 'object';
  if (type === undefined && schema.items !== undefined) type = 'array';
  if (type === undefined || type === 'null') {
    throw new Error(`connector: untyped schema at ${path} (Swagger 2.0 needs an exact type)`);
  }

  const out: JsonObject = { type };
  if (typeof schema.description === 'string') out.description = sentence(schema.description);
  if (typeof schema.format === 'string') out.format = schema.format;
  if (schema.const !== undefined) out.enum = [schema.const];
  else if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (schema.default !== undefined) out.default = schema.default;
  for (const key of ['minLength', 'maxLength', 'pattern', 'multipleOf'] as const) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (typeof schema.minimum === 'number' && Math.abs(schema.minimum) < SAFE_BOUND) {
    out.minimum = schema.minimum;
  }
  if (typeof schema.maximum === 'number' && Math.abs(schema.maximum) < SAFE_BOUND) {
    out.maximum = schema.maximum;
  }
  if (typeof schema.exclusiveMinimum === 'number') {
    out.minimum = schema.exclusiveMinimum;
    out.exclusiveMinimum = true;
  }
  if (typeof schema.exclusiveMaximum === 'number') {
    out.maximum = schema.exclusiveMaximum;
    out.exclusiveMaximum = true;
  }

  if (type === 'object') {
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    const converted: JsonObject = {};
    for (const [key, child] of Object.entries(properties)) {
      const prop = toSwaggerSchema(child, `${path}.${key}`);
      prop['x-ms-summary'] ??= summaryText(words(key));
      prop.description = sentence(
        typeof prop.description === 'string' && prop.description !== ''
          ? prop.description
          : words(key),
      );
      converted[key] = prop;
    }
    out.properties = converted;
    if (Array.isArray(schema.required)) {
      const required = (schema.required as string[]).filter((k) => k in converted);
      if (required.length > 0) out.required = required;
    }
    // `additionalProperties: false` is dropped: a connector must not forbid a field the API adds later.
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      out.additionalProperties = toSwaggerSchema(
        schema.additionalProperties,
        `${path}.additionalProperties`,
      );
    }
  } else if (type === 'array') {
    out.items = toSwaggerSchema(schema.items, `${path}[]`);
  }

  if (nullable) out['x-nullable'] = true;
  return out;
}

function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): JsonObject {
  return z.toJSONSchema(schema, { io, unrepresentable: 'any' }) as JsonObject;
}

// ── parameters ────────────────────────────────────────────────────────────────

const RESERVED_DESCRIPTIONS: Record<string, string> = {
  page: 'Page number, starting at 1.',
  per_page: 'Records per page, from 1 to 100 (25 by default).',
  q: 'Text to search for across every text field of the record (case-insensitive).',
  since: 'Only changes observed on or after this date (YYYY-MM-DD). Default: the last 7 days.',
  change: 'Only changes of this kind: added, removed or changed.',
};

const ADVANCED_PARAMS = new Set(['page', 'per_page', 'q']);

/**
 * What a query parameter does, from the platform's own query language (sources/types.ts):
 * dataset-agnostic by rule, so the connector never carries dataset-specific text outside
 * the source file (CLAUDE.md isolation rule). A zod `.describe()` on the param wins.
 */
export function parameterDescription(name: string, source: DataSource, own?: string): string {
  if (own && own.trim() !== '') return sentence(own);
  if (name in RESERVED_DESCRIPTIONS) return RESERVED_DESCRIPTIONS[name]!;
  if (source.lookup?.keys.includes(name)) {
    return `Identifies the record to look up in ${source.title}; give at least one of: ${source.lookup.keys.join(', ')}.`;
  }
  const dated = /^(.+)_(after|before)$/.exec(name);
  if (dated) {
    const bound = dated[2] === 'after' ? 'on or after' : 'on or before';
    return `Only records whose ${words(dated[1]!).toLowerCase()} is ${bound} this date (YYYY-MM-DD).`;
  }
  const ranged = /^(.+)_(min|max)$/.exec(name);
  if (ranged) {
    const bound = ranged[2] === 'min' ? 'at least' : 'at most';
    return `Only records whose ${words(ranged[1]!).toLowerCase()} is ${bound} this number.`;
  }
  const present = /^(.+)_present$/.exec(name);
  if (present) {
    return `Only records where ${words(present[1]!).toLowerCase()} has a value (true) or is empty (false).`;
  }
  return `Only records whose ${words(name).toLowerCase()} contains this text (case-insensitive); exact match for numbers and true/false.`;
}

const PARAMETER_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

export function queryParameters(source: DataSource, schema: z.ZodObject): JsonObject[] {
  const generated = jsonSchemaOf(schema, 'input');
  const properties = (generated.properties ?? {}) as Record<string, unknown>;
  return Object.entries(properties).map(([name, node]) => {
    const converted = toSwaggerSchema(node, `${source.slug}?${name}`);
    const type = String(converted.type);
    if (!PARAMETER_TYPES.has(type)) {
      throw new Error(
        `connector: ${source.slug}?${name} is a ${type}; query params must be scalar`,
      );
    }
    const parameter: JsonObject = {
      name,
      in: 'query',
      required: false,
      type,
      description: parameterDescription(
        name,
        source,
        typeof converted.description === 'string' ? converted.description : undefined,
      ),
      'x-ms-summary': summaryText(words(name)),
    };
    for (const key of ['format', 'enum', 'default', 'minimum', 'maximum'] as const) {
      if (converted[key] !== undefined) parameter[key] = converted[key];
    }
    if (ADVANCED_PARAMS.has(name)) parameter['x-ms-visibility'] = 'advanced';
    return parameter;
  });
}

// ── operations ────────────────────────────────────────────────────────────────

function response(description: string, schema: z.ZodType, path: string): JsonObject {
  return {
    '200': {
      description: sentence(description),
      schema: toSwaggerSchema(jsonSchemaOf(schema, 'output'), path),
    },
  };
}

/** The page meta with its fields described (the OpenAPI document leaves them bare). */
const pageMeta = paginationMeta.extend({
  source: z.string().describe('The dataset slug'),
  page: z.int().describe('The page returned'),
  per_page: z.int().describe('Records per page'),
  total: z.int().describe('Total matching records across all pages'),
  last_refreshed_at: z
    .string()
    .nullable()
    .describe('When the dataset was last refreshed (ISO date-time), null before the first refresh'),
});

function envelope(data: z.ZodType, meta = false): z.ZodType {
  return z.object({
    ok: z.literal(true).describe('True when the call succeeded'),
    data,
    ...(meta ? { meta: pageMeta.describe('Page, total and freshness of the data') } : {}),
  });
}

/** Operation description: the source's one-liner cut to whole sentences, plus what one call returns. */
export function operationDescription(source: DataSource): string {
  const shape = source.lookup
    ? 'One call returns the one record named by the lookup key and costs one credit.'
    : 'One call returns one page of matching records (25 by default, up to 100) with the total count and the last refresh time, and costs the credits the sources listing states.';
  const budget = DESCRIPTION_MAX - shape.length - 1;
  const summary = sentence(leadingSentences(source.description, budget));
  const full = `${summary} ${shape}`;
  if (full.length <= DESCRIPTION_MAX) return full;
  // the source's first sentence alone is over budget: the title still says what the action reads
  return `Records from ${sentence(source.title)} ${shape}`;
}

export function dataOperation(source: DataSource): JsonObject {
  const dataSchema = source.lookup
    ? z.array(source.recordSchema).describe('The record, as a one-element list')
    : z.array(source.recordSchema).describe('The matching records');
  return {
    get: {
      operationId: operationId('query', source.slug),
      summary: summaryText(source.title),
      description: operationDescription(source),
      'x-ms-visibility': 'important',
      parameters: queryParameters(source, buildQuerySchema(source)),
      responses: response(
        source.lookup ? `The ${source.title} record` : `Matching ${source.title} records`,
        envelope(dataSchema, true),
        `/v1/data/${source.slug}`,
      ),
    },
  };
}

export function changesOperation(source: DataSource): JsonObject {
  const row = changeRowSchema.extend({
    change: z
      .enum(['added', 'removed', 'changed'])
      .describe('Whether the record was added to, removed from or changed in the register'),
    changed_at: z.string().describe('When the change was observed (ISO date-time)'),
    record_id: z.string().describe('The stable id of the record in this register'),
    record: source.recordSchema.describe('The record as it reads after the change'),
  });
  const filters = changeFiltersSchema(source).extend(changesQuerySchema.shape);
  return {
    get: {
      operationId: operationId('changes', source.slug),
      summary: summaryText(`${source.title} changes`),
      description:
        `Rows added, removed or changed in ${source.title} between daily refreshes, newest first, ` +
        `with 90 days of history. Poll this instead of re-reading the whole register; the same filters ` +
        `as the query apply to the changed record, so one call is a watch. Costs the same credits as a query.`,
      'x-ms-visibility': 'important',
      parameters: queryParameters(source, filters),
      responses: response(
        `Changes to ${source.title}`,
        envelope(z.array(row).describe('The changed rows, newest first'), true),
        `/v1/changes/${source.slug}`,
      ),
    },
  };
}

const usageSchema = z.object({
  plan: z.string().describe('The plan the key is on'),
  period: z.string().describe('The current billing period (YYYY-MM)'),
  used: z.number().describe('Credits used this period'),
  granted: z.number().describe('Credits the plan grants per period'),
  remaining: z.number().describe('Credits left this period'),
  alerts: z.array(z.string().describe('An alert line')).describe('Quota alerts, if any'),
});

export function platformOperations(): JsonObject {
  return {
    '/v1/data': {
      get: {
        operationId: 'list_sources',
        summary: 'List datasets',
        description:
          'Lists every dataset with its filters, refresh schedule, credit cost per call and whether it carries a change feed.',
        'x-ms-visibility': 'advanced',
        parameters: [],
        responses: response(
          'The registered datasets',
          envelope(sourceListingSchema.describe('One entry per dataset')),
          '/v1/data',
        ),
      },
    },
    '/v1/usage': {
      get: {
        operationId: 'get_usage',
        summary: 'Get credit usage',
        description:
          'Reads the credits used and remaining this period for the connected key. This call is free.',
        'x-ms-visibility': 'advanced',
        parameters: [],
        responses: response('The usage summary', envelope(usageSchema), '/v1/usage'),
      },
    },
  };
}

// ── the package ───────────────────────────────────────────────────────────────

export function renderSwagger(): JsonObject {
  const sources = listSources();
  const paths: JsonObject = {
    ...Object.fromEntries(sources.map((s) => [`/v1/data/${s.slug}`, dataOperation(s)])),
    ...Object.fromEntries(
      sources.filter(hasChangeFeed).map((s) => [`/v1/changes/${s.slug}`, changesOperation(s)]),
    ),
    ...platformOperations(),
  };
  return {
    swagger: '2.0',
    info: {
      title: CONNECTOR_TITLE,
      description: CONNECTOR_DESCRIPTION,
      version: APP_VERSION,
      contact: { name: 'gankdat', url: `${API_BASE_URL}/feedback`, email: 'info@gankdat.com' },
    },
    host: CONNECTOR_HOST,
    basePath: '/',
    schemes: ['https'],
    consumes: [],
    produces: ['application/json'],
    paths,
    definitions: {},
    parameters: {},
    responses: {},
    securityDefinitions: {
      'API Key': { type: 'apiKey', in: 'header', name: 'Authorization' },
    },
    security: [{ 'API Key': [] }],
    tags: [],
    'x-ms-connector-metadata': [
      { propertyName: 'Website', propertyValue: API_BASE_URL },
      { propertyName: 'Privacy policy', propertyValue: `${API_BASE_URL}/privacy` },
      { propertyName: 'Categories', propertyValue: CONNECTOR_CATEGORIES },
    ],
  };
}

export function renderApiProperties(): JsonObject {
  return {
    properties: {
      connectionParameters: {
        api_key: {
          type: 'securestring',
          uiDefinition: {
            displayName: "API key (in the form 'Bearer yourKey')",
            description: KEY_INSTRUCTION,
            tooltip: "Provide your gankdat key as 'Bearer yourKey'",
            constraints: { tabIndex: 2, clearText: false, required: 'true' },
          },
        },
      },
      iconBrandColor: ICON_BRAND_COLOR,
      capabilities: [],
      publisher: 'gankdat',
      stackOwner: 'gankdat',
    },
  };
}

interface OperationRow {
  summary: string;
  description: string;
  operationId: string;
}

/** Every operation in path order, read back from the rendered document. */
export function operationRows(swagger: JsonObject = renderSwagger()): OperationRow[] {
  const rows: OperationRow[] = [];
  for (const item of Object.values(swagger.paths as Record<string, JsonObject>)) {
    const get = item.get as JsonObject;
    rows.push({
      summary: String(get.summary),
      description: String(get.description),
      operationId: String(get.operationId),
    });
  }
  return rows;
}

function datasetTable(): string {
  return [
    '| Dataset | Action | Change feed |',
    '| --- | --- | --- |',
    ...listSources().map(
      (s) =>
        `| ${s.title} | \`${operationId('query', s.slug)}\` | ${hasChangeFeed(s) ? `\`${operationId('changes', s.slug)}\`` : '—'} |`,
    ),
  ].join('\n');
}

/** readme.md for the open-sourced folder in microsoft/PowerPlatformConnectors (the repo's own headings). */
export function renderReadme(): string {
  const ops = operationRows()
    .map((row) => `### ${row.summary}\n${row.description}`)
    .join('\n\n');
  return `# gankdat
${CONNECTOR_DESCRIPTION}

## Publisher: gankdat

## Prerequisites
- An account at https://gankdat.com/account (sign-in by email, no password). The free plan carries 250 credits a month; paid plans and one-off credit packs are sold on gankdat.com.
- An API key from that account. The connection takes it as \`Bearer yourKey\`.

## Supported Operations
Every dataset has one query action; every register dataset also has a change-feed action that returns what was added, removed or changed since a date. Each action returns \`ok\`, \`data\` (the records) and \`meta\` (page, total, last refresh).

${datasetTable()}

${ops}

## Obtaining Credentials
1. Sign in at https://gankdat.com/account with your email address.
2. Create an API key on the account page and copy it.
3. When the connector asks for the connection, enter the key as \`Bearer yourKey\` (the word Bearer, a space, then the key).

## Known Issues and Limitations
- One query costs the credits the dataset lists (one by default); a key over its monthly allowance receives a 402 until the period resets or credits are bought.
- Queries are paged (25 records by default, 100 at most); use \`page\` to read further pages.
- Change feeds hold 90 days of history and are only offered for register datasets (the table above).
- The keyless preview that gankdat offers to AI agents is not available through this connector: a connection always carries a key.

## Deployment Instructions
The package is generated from the API's own schema registry (\`npm run connector\` in the gankdat repository) — do not edit the Swagger by hand. To deploy it as a custom connector in your own environment, use the [paconn](https://learn.microsoft.com/connectors/custom-connectors/paconn-cli) CLI:

\`\`\`
paconn login
paconn create --api-prop apiProperties.json --api-def apiDefinition.swagger.json --icon icon.png
\`\`\`

## Frequently Asked Questions
### Where does the data come from?
Official open-data publications of the UK and EU registers named in each dataset's description; the licence and personal-data posture of each is stated at https://gankdat.com/terms.

### How fresh is it?
Register datasets refresh every night; the \`last_refreshed_at\` field in \`meta\` says when. The company lookup reads the register on demand.
`;
}

/** intro.md for the Partner Center package: the connector's reference page on Microsoft Learn. */
export function renderIntro(): string {
  return `${CONNECTOR_DESCRIPTION}

## Prerequisites
You need a gankdat account and an API key. Sign in at https://gankdat.com/account with your email address and create a key there; the free plan carries 250 credits a month, and paid plans and credit packs are sold on the same page.

## How to get credentials
Create an API key at https://gankdat.com/account. When you create the connection, enter the key as \`Bearer yourKey\` — the word Bearer, a space, then the key.

## Get started with your connector
Add a gankdat action to a flow or app, pick the dataset, set the filters you need (every text filter is a case-insensitive contains, dates take YYYY-MM-DD, numbers and true/false match exactly) and read the records from \`data\`. To watch a register instead of re-reading it, use its changes action with \`since\` set to the last run.

${datasetTable()}

## Known issues and limitations
- Each query costs the credits the dataset lists (one by default). A key over its monthly allowance receives a 402 until the period resets or credits are bought.
- Results are paged: 25 records by default, 100 at most per call.
- Change feeds hold 90 days of history and exist for register datasets only.

## Common errors and remedies
- **401** — the connection's key is missing, mistyped or revoked, or was entered without the word \`Bearer\`. Create a new key at https://gankdat.com/account and recreate the connection.
- **402** — the month's credits are spent. Wait for the period to reset or buy credits on the account page.
- **429** — more than the dataset's rate limit in a minute. Retry after the \`Retry-After\` seconds.

## FAQ
### Is personal data returned?
No. Every dataset is organisation-level; personal fields are dropped before storage, as https://gankdat.com/privacy states.

### Which plans work with the connector?
Any gankdat plan, the free one included. The connector itself is free; the store does not bill.
`;
}

export interface ConnectorPackage {
  swagger: JsonObject;
  apiProperties: JsonObject;
  readme: string;
  intro: string;
}

export function renderConnector(): ConnectorPackage {
  return {
    swagger: renderSwagger(),
    apiProperties: renderApiProperties(),
    readme: renderReadme(),
    intro: renderIntro(),
  };
}
