// Apify actor scaffold (foundry `gankdat-actor-scaffold`, 2026-11-17): the files of
// `apify/<slug>/` for a registered source, derived from its zod schemas.
//
// Why: three dataset builds in six days copied a neighbouring actor folder by hand, and the
// 2026-11-17 build still failed test/apify-schemas.spec.ts twice (a 304-character description,
// an integer param). The dataset schema is the record schema's JSON types, the input schema is
// the query params' — both derivable — while the listing copy (title, description, README, what
// each filter is for) is the builder's to write. So the scaffold writes the derivable part
// complete and marks every line that needs words with `TODO`, which the schema test refuses, so
// a half-written actor cannot ship.
//
// Used by scripts/actor.mjs (`npm run actor -- <slug>`); pure — no file access here.
import { z } from 'zod';
import type { DataSource } from '../sources/types';

/** Apify Store limits (actor.json): a longer title or description fails the push. */
export const TITLE_MAX = 63;
export const DESCRIPTION_MAX = 300;
/** Every line the builder must still write carries this; test/apify-schemas.spec.ts refuses it. */
export const TODO = 'TODO';

const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

interface JsonNode {
  type?: string | string[];
  anyOf?: JsonNode[];
  oneOf?: JsonNode[];
  items?: JsonNode;
  enum?: unknown[];
  format?: string;
  description?: string;
  properties?: Record<string, JsonNode>;
}

function propertiesOf(schema: z.ZodType): Record<string, JsonNode> {
  return (z.toJSONSchema(schema, { unrepresentable: 'any' }) as JsonNode).properties ?? {};
}

/** Every primitive JSON type a node admits, `null` included, through `anyOf` / `oneOf`. */
function typesOf(node: JsonNode | undefined): string[] {
  const out: string[] = [];
  const visit = (n: JsonNode | undefined): void => {
    if (!n) return;
    for (const t of Array.isArray(n.type) ? n.type : n.type ? [n.type] : [])
      if (!out.includes(t)) out.push(t);
    for (const alt of [...(n.anyOf ?? []), ...(n.oneOf ?? [])]) visit(alt);
  };
  visit(node);
  return out;
}

/** The first alternative of a node that carries `key` (an `anyOf` wraps a nullable array's `items`). */
function find<K extends keyof JsonNode>(node: JsonNode | undefined, key: K): JsonNode[K] {
  if (!node) return undefined;
  if (node[key] !== undefined) return node[key];
  for (const alt of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
    const found = find(alt, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface DatasetField {
  type: string | string[];
  items?: { type: string };
}

/** One dataset-schema property: the record field's JSON types, `null` last, array items typed. */
export function datasetField(node: JsonNode | undefined): DatasetField {
  const all = typesOf(node);
  const types = all.filter((t) => t !== 'null');
  // An unconstrained field (z.unknown) admits anything; Apify needs the list spelt out.
  const named = types.length > 0 ? types : ['string', 'number', 'boolean', 'object', 'array'];
  const nullable = all.includes('null') || types.length === 0;
  const withNull = nullable ? [...named, 'null'] : named;
  const field: DatasetField = {
    type: withNull.length === 1 ? (withNull[0] ?? 'string') : withNull,
  };
  if (named.includes('array')) {
    const itemType = typesOf(find(node, 'items')).find((t) => t !== 'null');
    field.items = { type: itemType ?? 'string' };
  }
  return field;
}

export interface DatasetSchema {
  actorSpecification: 1;
  fields: { type: 'object'; properties: Record<string, DatasetField> };
  views: {
    overview: {
      title: 'Overview';
      transformation: { fields: string[] };
      display: { component: 'table' };
    };
  };
}

/** A source has a change feed when it has a stable id and lives in D1 (registry `hasChangeFeed`). */
export function feedOf(source: DataSource): boolean {
  return source.idOf !== undefined && source.storage === 'd1';
}

/** `.actor/dataset_schema.json`: every record field, plus `change` / `changed_at` on a feed source. */
export function datasetSchema(source: DataSource): DatasetSchema {
  const properties: Record<string, DatasetField> = {};
  for (const [field, node] of Object.entries(propertiesOf(source.recordSchema)))
    properties[field] = datasetField(node);
  if (feedOf(source)) {
    properties.change = { type: ['string', 'null'] };
    properties.changed_at = { type: ['string', 'null'] };
  }
  return {
    actorSpecification: 1,
    fields: { type: 'object', properties },
    views: {
      overview: {
        title: 'Overview',
        // Every field in record order; trim to the columns a buyer reads first.
        transformation: { fields: Object.keys(properties) },
        display: { component: 'table' },
      },
    },
  };
}

/** `company_number` → `Company number`; the filter suffixes read as words. */
export function titleOf(param: string): string {
  const suffixes: [RegExp, string][] = [
    [/_min$/, ' at least'],
    [/_max$/, ' at most'],
    [/_after$/, ' on or after'],
    [/_before$/, ' on or before'],
  ];
  let stem = param;
  let tail = '';
  for (const [pattern, words] of suffixes) {
    if (pattern.test(param)) {
      stem = param.replace(pattern, '');
      tail = words;
      break;
    }
  }
  const words = stem.replace(/_/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}${tail}`;
}

export type InputField = Record<string, unknown>;

/**
 * One input-schema property for a query param, or `undefined` when Apify's input form has no
 * editor for it (an array or object param) — the caller lists those as skipped.
 */
export function inputField(param: string, node: JsonNode | undefined): InputField | undefined {
  const types = typesOf(node).filter((t) => t !== 'null');
  const described = find(node, 'description');
  const base = {
    title: titleOf(param),
    description: described ?? `${TODO}: what this filter keeps, with an example value.`,
  };
  if (types.includes('boolean')) return { type: 'boolean', editor: 'checkbox', ...base };
  // Apify's only numeric input type is integer; the API coerces the query string either way.
  if (types.includes('number') || types.includes('integer'))
    return { type: 'integer', editor: 'number', ...base };
  if (types.includes('string')) {
    const options = find(node, 'enum');
    if (options && options.every((o) => typeof o === 'string'))
      return { type: 'string', editor: 'select', ...base, enum: options, enumTitles: options };
    if (find(node, 'format') === 'date')
      return { type: 'string', editor: 'textfield', ...base, pattern: DATE_PATTERN };
    return { type: 'string', editor: 'textfield', ...base };
  }
  return undefined;
}

export interface InputSchema {
  title: string;
  type: 'object';
  schemaVersion: 1;
  properties: Record<string, InputField>;
  required: string[];
}

const FEED_INPUTS: Record<string, InputField> = {
  mode: {
    title: 'Mode',
    type: 'string',
    description: `${TODO}: Current register (default), or only the records added or changed since a date — say what a daily run in changes mode shows for this register.`,
    editor: 'select',
    enum: ['data', 'changes'],
    enumTitles: ['Current register', 'Changes since a date (monitor)'],
    default: 'data',
  },
  since: {
    title: 'Changes since',
    type: 'string',
    description: 'Changes mode only: YYYY-MM-DD. Default: the last 7 days. The feed keeps 90 days.',
    editor: 'textfield',
    pattern: DATE_PATTERN,
  },
  change: {
    title: 'Change type',
    type: 'string',
    description: 'Changes mode only: one kind of change. Default: all.',
    editor: 'select',
    enum: ['added', 'removed', 'changed'],
    enumTitles: ['Added to the register', 'Removed from the register', 'Changed'],
  },
};

/** `.actor/input_schema.json` and the query params left out for want of an editor. */
export function inputSchema(
  source: DataSource,
  title: string,
): { schema: InputSchema; skipped: string[] } {
  const properties: Record<string, InputField> = feedOf(source) ? structuredClone(FEED_INPUTS) : {};
  const skipped: string[] = [];
  for (const [param, node] of Object.entries(propertiesOf(source.queryParams))) {
    const field = inputField(param, node);
    if (field) properties[param] = field;
    else skipped.push(param);
  }
  properties.q = {
    type: 'string',
    editor: 'textfield',
    title: 'Free-text search',
    description: 'Filter: Free-text search (case-insensitive substring match).',
  };
  properties.max_results = {
    title: 'Maximum results',
    type: 'integer',
    description: 'Stop after this many results (you are charged per result).',
    default: 1000,
    minimum: 1,
    maximum: 100000,
  };
  return {
    schema: {
      title: `${title} — filters`,
      type: 'object',
      schemaVersion: 1,
      properties,
      required: [],
    },
    skipped,
  };
}

/** `src/main.mjs`, the one template test/apify-schemas.spec.ts accepts for a dataset actor. */
export function mainModule(source: DataSource): string {
  const head = `import { Actor } from 'apify';\nimport { runDatasetActor } from './gankdat.mjs';\n\nawait Actor.init();\nconst input = (await Actor.getInput()) ?? {};\n`;
  const body = feedOf(source)
    ? `const { max_results: maxResults = 1000, mode, since, change, ...filters } = input;\nawait runDatasetActor('${source.slug}', filters, Number(maxResults), { mode, since, change });\n`
    : `const { max_results: maxResults = 1000, ...filters } = input;\nawait runDatasetActor('${source.slug}', filters, Number(maxResults));\n`;
  return `${head}${body}await Actor.exit();\n`;
}

const OUTPUT_SCHEMA = {
  actorOutputSchemaVersion: 1,
  title: 'Output',
  properties: {
    results: {
      title: 'Results',
      description:
        'One item per record, as JSON (also downloadable as CSV/Excel from the dataset).',
      template: '{{links.apiDefaultDatasetUrl}}/items',
      type: 'string',
    },
  },
};

function readme(source: DataSource, title: string, fields: string[]): string {
  const monitor = feedOf(source)
    ? `\n## Monitor it (changes mode)\nSet **Mode** to *Changes since a date (monitor)* and the run returns only the records added or changed since **Changes since** (default: the last 7 days; the feed keeps 90 days). ${TODO}: say what a scheduled daily run gives the buyer.\n`
    : '';
  return `# ${title}\n\n${TODO}: the question this actor answers in bold, then one sentence naming the official source.\n\n- ${TODO}: three or four bullets, one per group of fields.\n\n## What people use it for\n- ${TODO}: three uses, each with who does it.\n\n## Output (one item per ${TODO}: record unit)\n\`${fields.join(', ')}\`\n\n## Data posture\n${TODO}: the licence, what is never ingested, and the pay-per-result line.\n${monitor}`;
}

export interface ScaffoldOptions {
  /** Store title, ≤ TITLE_MAX; a TODO line when absent. */
  title?: string;
  /** The actor's Store name (its URL slug, e.g. `uk-gender-pay-gap-reports`); the dataset slug when absent. */
  name?: string;
  /** Store description, ≤ DESCRIPTION_MAX; a TODO line when absent. */
  description?: string;
  /** `YYYY-MM-DD` for the apify/README.md row. */
  today: string;
}

export interface Scaffold {
  /** Path under `apify/<slug>/` → file text (JSON unformatted; the script runs Prettier). */
  files: Record<string, string>;
  /** The row to append to the "Published actors" table of apify/README.md. */
  readmeRow: string;
  /** Query params with no input editor, for the script to print. */
  skipped: string[];
  /** How many lines still carry TODO. */
  todos: number;
}

/**
 * The actor folder for a dataset source. Throws for a lookup source (its actor takes the
 * buyer's own list — copy apify/uk-company-profiles/), and for a title or description over the
 * Store's limits, so the length is checked when the words are written and not by the push.
 */
export function scaffoldActor(source: DataSource, options: ScaffoldOptions): Scaffold {
  if (source.lookup !== undefined)
    throw new Error(
      `${source.slug} is a lookup source: its actor takes the buyer's list — copy apify/uk-company-profiles/ instead`,
    );
  const { title, description } = options;
  if (title !== undefined && title.length > TITLE_MAX)
    throw new Error(`title is ${title.length} chars; the Apify Store allows ${TITLE_MAX}`);
  if (description !== undefined && description.length > DESCRIPTION_MAX)
    throw new Error(
      `description is ${description.length} chars; the Apify Store allows ${DESCRIPTION_MAX}`,
    );
  if (options.name !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(options.name))
    throw new Error(`name "${options.name}" must be lowercase words joined by hyphens`);
  const shownTitle = title ?? `${TODO}: Store title, at most ${TITLE_MAX} chars`;
  const dataset = datasetSchema(source);
  const input = inputSchema(source, shownTitle);
  const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  const files: Record<string, string> = {
    '.actor/actor.json': json({
      actorSpecification: 1,
      name: options.name ?? source.slug,
      title: shownTitle,
      description:
        description ??
        `${TODO}: Store description, at most ${DESCRIPTION_MAX} chars — what the register is, the official source, the fields a buyer filters on.`,
      version: '0.1',
      buildTag: 'latest',
      dockerfile: '../Dockerfile',
      readme: './README.md',
      input: './input_schema.json',
      environmentVariables: { GANKDAT_API_KEY: '@gankdatApiKey' },
      minMemoryMbytes: 256,
      maxMemoryMbytes: 512,
      output: './output_schema.json',
      storages: { dataset: './dataset_schema.json' },
    }),
    '.actor/dataset_schema.json': json(dataset),
    '.actor/input_schema.json': json(input.schema),
    '.actor/output_schema.json': json(OUTPUT_SCHEMA),
    '.actor/README.md': readme(source, shownTitle, Object.keys(dataset.fields.properties)),
    'src/main.mjs': mainModule(source),
    'package.json': json({
      name: `gankdat-apify-${source.slug}`,
      version: '0.1.0',
      private: true,
      type: 'module',
      description: `Apify actor: ${source.title} via gankdat.com`,
      scripts: { start: 'node src/main.mjs' },
      dependencies: { apify: '^3.4.0' },
    }),
  };
  const todos = Object.values(files)
    .join('\n')
    .split('\n')
    .filter((line) => line.includes(TODO)).length;
  return {
    files,
    readmeRow: `| \`${source.slug}\` | pushed by CI on the ${options.today} commit | https://console.apify.com/actors |`,
    skipped: input.skipped,
    todos,
  };
}
