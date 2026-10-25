import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_HOST,
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  ICON_BRAND_COLOR,
  KEY_INSTRUCTION,
  PRODUCT_NAMES,
  SUMMARY_MAX,
  TITLE_BANNED_WORDS,
  TITLE_MAX,
  leadingSentences,
  operationId,
  parameterDescription,
  renderConnector,
  sentence,
  summaryText,
  toSwaggerSchema,
  words,
} from '../src/connector/render';
import { APP_VERSION } from '../src/lib/constants';
import { hasChangeFeed, listSources } from '../src/sources/registry';
import committedProperties from '../connector/apiProperties.json?raw';
import committedSwagger from '../connector/apiDefinition.swagger.json?raw';
import committedIntro from '../connector/intro.md?raw';
import committedReadme from '../connector/readme.md?raw';

/**
 * Power Platform certified-connector package (gankdat `power-platform-certified-connector`,
 * 2026-10-25). Microsoft's certification rules, read from "Prepare connector files for
 * certification" through the relay (docs/relay/responses/power-platform-connector-shelf/3),
 * are checked here against the whole rendered package for every registered source, and the
 * committed files under connector/ must equal what the registry renders now — a new dataset
 * or a renamed field that is not followed by `npm run connector` fails the gate instead of
 * shipping a stale package.
 */

type JsonObject = Record<string, unknown>;
interface Operation {
  operationId: string;
  summary: string;
  description: string;
  parameters: JsonObject[];
  responses: Record<string, { description: string; schema?: JsonObject }>;
  'x-ms-visibility'?: string;
}

const pkg = renderConnector();
const swagger = pkg.swagger as JsonObject & {
  paths: Record<string, { get: Operation }>;
  info: { title: string; description: string; version: string };
};
const operations = Object.entries(swagger.paths).map(([path, item]) => ({ path, op: item.get }));

const SUMMARY = /^[A-Za-z0-9() ]+$/;
const ENDS_WITH_PUNCTUATION = /[.!?]$/;
const containsAny = (text: string, list: string[]): string | undefined =>
  list.find((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
const containsBanned = (text: string): string | undefined => containsAny(text, PRODUCT_NAMES);

/** Every schema node under `node`, with its JSON path. */
function* schemaNodes(node: unknown, path = '$'): Generator<[string, JsonObject]> {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) yield* schemaNodes(child, `${path}[${i}]`);
    return;
  }
  const obj = node as JsonObject;
  if (typeof obj.type === 'string') yield [path, obj];
  for (const [key, child] of Object.entries(obj)) yield* schemaNodes(child, `${path}.${key}`);
}

describe('connector title and description (certification step 1)', () => {
  it('title is short, unique-looking and free of product words', () => {
    expect(swagger.swagger).toBe('2.0');
    expect(swagger.info.title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(swagger.info.title).toMatch(/[A-Za-z0-9]$/);
    expect(containsAny(swagger.info.title, TITLE_BANNED_WORDS)).toBeUndefined();
    expect(swagger.info.version).toBe(APP_VERSION);
  });

  it('description is 30–500 characters without product names', () => {
    expect(swagger.info.description.length).toBeGreaterThan(DESCRIPTION_MIN);
    expect(swagger.info.description.length).toBeLessThan(DESCRIPTION_MAX);
    expect(containsBanned(swagger.info.description)).toBeUndefined();
  });

  it('names the production host over https with the bearer header as the one API key', () => {
    expect(swagger.host).toBe(CONNECTOR_HOST);
    expect(swagger.host).toBe('gankdat.com');
    expect(swagger.schemes).toEqual(['https']);
    expect(swagger.basePath).toBe('/');
    expect(swagger.securityDefinitions).toEqual({
      'API Key': { type: 'apiKey', in: 'header', name: 'Authorization' },
    });
    expect(swagger.security).toEqual([{ 'API Key': [] }]);
  });

  it('carries the connector metadata the shelf lists (website, privacy policy, categories)', () => {
    const metadata = swagger['x-ms-connector-metadata'] as {
      propertyName: string;
      propertyValue: string;
    }[];
    const byName = Object.fromEntries(metadata.map((m) => [m.propertyName, m.propertyValue]));
    expect(byName.Website).toBe('https://gankdat.com');
    expect(byName['Privacy policy']).toBe('https://gankdat.com/privacy');
    expect(byName.Categories).toMatch(/^[A-Za-z ]+(;[A-Za-z ]+)*$/);
  });
});

describe('operations (one per dataset, one per change feed, listing and usage)', () => {
  it('has a query action for every registered source and a changes action for every feed', () => {
    for (const source of listSources()) {
      expect(swagger.paths[`/v1/data/${source.slug}`]?.get.operationId).toBe(
        operationId('query', source.slug),
      );
      const changes = swagger.paths[`/v1/changes/${source.slug}`];
      if (hasChangeFeed(source)) {
        expect(changes?.get.operationId).toBe(operationId('changes', source.slug));
      } else {
        expect(changes).toBeUndefined();
      }
    }
    expect(swagger.paths['/v1/data']?.get.operationId).toBe('list_sources');
    expect(swagger.paths['/v1/usage']?.get.operationId).toBe('get_usage');
    expect(operations.length).toBe(
      listSources().length + listSources().filter(hasChangeFeed).length + 2,
    );
  });

  it('operation ids are unique', () => {
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every operation has a summary (≤ 80 chars, letters digits spaces parentheses), a full-sentence description and a visibility', () => {
    for (const { path, op } of operations) {
      expect(op.summary, path).toMatch(SUMMARY);
      expect(op.summary.length, path).toBeLessThanOrEqual(SUMMARY_MAX);
      expect(op.description, path).toMatch(ENDS_WITH_PUNCTUATION);
      expect(op.description.length, path).toBeLessThanOrEqual(DESCRIPTION_MAX);
      expect(containsBanned(op.summary), path).toBeUndefined();
      expect(containsBanned(op.description), path).toBeUndefined();
      expect(['important', 'advanced', 'internal'], path).toContain(op['x-ms-visibility']);
    }
  });

  it('every parameter is a scalar query parameter with an x-ms-summary and a sentence description', () => {
    for (const { path, op } of operations) {
      for (const parameter of op.parameters) {
        const where = `${path}?${String(parameter.name)}`;
        expect(parameter.in, where).toBe('query');
        expect(parameter.required, where).toBe(false);
        expect(['string', 'number', 'integer', 'boolean'], where).toContain(parameter.type);
        expect(String(parameter['x-ms-summary']), where).toMatch(SUMMARY);
        expect(String(parameter['x-ms-summary']).length, where).toBeLessThanOrEqual(SUMMARY_MAX);
        expect(String(parameter.description), where).toMatch(ENDS_WITH_PUNCTUATION);
      }
      const names = op.parameters.map((p) => p.name);
      expect(new Set(names).size, path).toBe(names.length);
    }
  });

  it('data and changes actions take the source filters plus page, per_page and q', () => {
    for (const source of listSources()) {
      const names = swagger.paths[`/v1/data/${source.slug}`]!.get.parameters.map((p) => p.name);
      for (const key of Object.keys(source.queryParams.shape)) expect(names).toContain(key);
      expect(names).toEqual(expect.arrayContaining(['page', 'per_page', 'q']));
      if (hasChangeFeed(source)) {
        const feed = swagger.paths[`/v1/changes/${source.slug}`]!.get.parameters.map((p) => p.name);
        expect(feed).toEqual(expect.arrayContaining(['since', 'change', 'page', 'per_page', 'q']));
      }
    }
  });
});

describe('responses (exact typed schemas, Swagger 2.0 only)', () => {
  it('defines exactly one 200 response per operation, no default, with an object schema', () => {
    for (const { path, op } of operations) {
      expect(Object.keys(op.responses), path).toEqual(['200']);
      const ok = op.responses['200']!;
      expect(ok.description, path).toMatch(ENDS_WITH_PUNCTUATION);
      expect(ok.schema?.type, path).toBe('object');
      const properties = ok.schema?.properties as JsonObject;
      expect(Object.keys(properties), path).toEqual(expect.arrayContaining(['ok', 'data']));
    }
  });

  it('types every record from the source schema: no empty schema, no 2020-12 construct', () => {
    let nodes = 0;
    for (const [path, node] of schemaNodes(swagger.paths)) {
      nodes += 1;
      for (const forbidden of [
        'anyOf',
        'oneOf',
        'allOf',
        'const',
        '$schema',
        '$ref',
        'propertyNames',
      ]) {
        expect(node, `${path} carries ${forbidden}`).not.toHaveProperty(forbidden);
      }
      expect(typeof node.exclusiveMinimum, path).not.toBe('number');
      if (node.type === 'object' && !('additionalProperties' in node)) {
        expect(Object.keys((node.properties as JsonObject) ?? {}).length, path).toBeGreaterThan(0);
      }
      if (node.type === 'array') expect(node.items, path).toBeDefined();
      if (node['x-ms-summary'] !== undefined) {
        expect(String(node['x-ms-summary']), path).toMatch(SUMMARY);
      }
      if (node.description !== undefined) {
        expect(String(node.description), path).toMatch(ENDS_WITH_PUNCTUATION);
      }
    }
    expect(nodes).toBeGreaterThan(500);
  });

  it('record fields of every source appear as typed properties of the data items', () => {
    for (const source of listSources()) {
      const schema = swagger.paths[`/v1/data/${source.slug}`]!.get.responses['200']!.schema!;
      const data = (schema.properties as Record<string, JsonObject>).data!;
      expect(data.type).toBe('array');
      const items = data.items as JsonObject;
      expect(items.type).toBe('object');
      const fields = Object.keys(items.properties as JsonObject);
      expect(fields.length, source.slug).toBeGreaterThan(2);
      for (const field of fields) {
        const prop = (items.properties as Record<string, JsonObject>)[field]!;
        expect(prop['x-ms-summary'], `${source.slug}.${field}`).toBeDefined();
      }
    }
  });
});

describe('connection parameters and icon', () => {
  const properties = pkg.apiProperties.properties as JsonObject;

  it('asks for one API key, in the Bearer form the shelf uses for bearer APIs', () => {
    const connection = properties.connectionParameters as Record<string, JsonObject>;
    expect(Object.keys(connection)).toEqual(['api_key']);
    const key = connection.api_key!;
    expect(key.type).toBe('securestring');
    const ui = key.uiDefinition as JsonObject;
    expect(ui.displayName).toContain("'Bearer yourKey'");
    expect(ui.description).toBe(KEY_INSTRUCTION);
    expect(ui.description).toContain('https://gankdat.com/account');
    expect(ui.constraints).toEqual({ tabIndex: 2, clearText: false, required: 'true' });
  });

  it('brand colour is a hex colour that is neither white nor the default blue; publisher named', () => {
    expect(properties.iconBrandColor).toBe(ICON_BRAND_COLOR);
    expect(ICON_BRAND_COLOR).toMatch(/^#[0-9a-f]{6}$/);
    expect(['#ffffff', '#007ee5']).not.toContain(ICON_BRAND_COLOR);
    expect(properties.publisher).toBe('gankdat');
    expect(properties.stackOwner).toBe('gankdat');
    expect(properties.capabilities).toEqual([]);
  });
});

describe('committed package matches the registry (run `npm run connector` after a dataset change)', () => {
  it('apiDefinition.swagger.json', () => {
    expect(JSON.parse(committedSwagger)).toEqual(pkg.swagger);
  });

  it('apiProperties.json', () => {
    expect(JSON.parse(committedProperties)).toEqual(pkg.apiProperties);
  });

  it('readme.md and intro.md name every dataset and the Bearer form', () => {
    expect(committedReadme).toBe(pkg.readme);
    expect(committedIntro).toBe(pkg.intro);
    for (const source of listSources()) {
      expect(committedReadme).toContain(source.title);
      expect(committedIntro).toContain(source.title);
    }
    expect(committedReadme).toContain('Bearer yourKey');
    expect(committedIntro).toContain('## Known issues and limitations');
    expect(containsBanned(committedIntro)).toBeUndefined();
  });
});

describe('text helpers', () => {
  it('summaryText keeps letters, digits, spaces and parentheses and cuts at a word', () => {
    expect(summaryText('Charities in England & Wales (Charity Commission)')).toBe(
      'Charities in England and Wales (Charity Commission)',
    );
    expect(summaryText('UK trade-marks: journal / weekly')).toBe('UK trade marks journal weekly');
    const long = summaryText('word '.repeat(40));
    expect(long.length).toBeLessThanOrEqual(SUMMARY_MAX);
    expect(long.endsWith('word')).toBe(true);
  });

  it('words and sentence', () => {
    expect(words('value_amount_min')).toBe('Value amount min');
    expect(sentence('No full stop')).toBe('No full stop.');
    expect(sentence('Already one!')).toBe('Already one!');
  });

  it('leadingSentences keeps whole sentences within the budget', () => {
    expect(leadingSentences('One. Two three. Four.', 10)).toBe('One.');
    expect(leadingSentences('One. Two three. Four.', 16)).toBe('One. Two three.');
  });

  it('parameterDescription reads the query language, not the dataset', () => {
    const source = listSources()[0]!;
    expect(parameterDescription('published_at_after', source)).toContain('on or after');
    expect(parameterDescription('value_amount_max', source)).toContain('at most');
    expect(parameterDescription('website_present', source)).toContain('has a value');
    expect(parameterDescription('buyer', source)).toContain('contains this text');
    expect(parameterDescription('page', source)).toBe('Page number, starting at 1.');
    expect(parameterDescription('x', source, 'Own text')).toBe('Own text.');
  });

  it('toSwaggerSchema turns nullable, const and unions into Swagger 2.0 shapes', () => {
    expect(toSwaggerSchema({ type: ['string', 'null'] })).toEqual({
      type: 'string',
      'x-nullable': true,
    });
    expect(toSwaggerSchema({ anyOf: [{ type: 'integer' }, { type: 'null' }] })).toEqual({
      type: 'integer',
      'x-nullable': true,
    });
    expect(toSwaggerSchema({ const: true })).toEqual({ type: 'boolean', enum: [true] });
    expect(toSwaggerSchema({ type: 'integer', minimum: -9007199254740991, maximum: 10 })).toEqual({
      type: 'integer',
      maximum: 10,
    });
    expect(toSwaggerSchema({ type: 'number', exclusiveMinimum: 0 })).toEqual({
      type: 'number',
      minimum: 0,
      exclusiveMinimum: true,
    });
    expect(() => toSwaggerSchema({}, '$.x')).toThrow(/untyped schema at \$\.x/);
    expect(() => toSwaggerSchema({ type: 'array' }, '$.y')).toThrow(/no schema at \$\.y\[\]/);
  });
});
