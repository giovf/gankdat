/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DESCRIPTION_MAX,
  TITLE_MAX,
  TODO,
  datasetField,
  datasetSchema,
  feedOf,
  inputSchema,
  mainModule,
  scaffoldActor,
  titleOf,
} from '../src/apify/scaffold';
import { getSource, hasChangeFeed, listSources } from '../src/sources/registry';
import type { DataSource } from '../src/sources/types';

// The scaffold (`npm run actor -- <slug>`, foundry `gankdat-actor-scaffold`) writes an actor
// folder from a source's zod schemas. Its proof is the folders already shipped: what it would
// write for each of them must satisfy the rules test/apify-schemas.spec.ts holds the committed
// files to, and for the folders built since 2026-11-12 it must be the committed schema exactly.

interface Committed {
  fields: { properties: Record<string, { type: string | string[] }> };
}
const committed = import.meta.glob<Committed>('../apify/*/.actor/dataset_schema.json', {
  eager: true,
  import: 'default',
});
const mains = import.meta.glob<string>('../apify/*/src/main.mjs', {
  eager: true,
  query: '?raw',
  import: 'default',
});
const datasetSources = listSources().filter((s) => s.lookup === undefined);
const squash = (code: string): string => code.replace(/\s+/g, ' ').replace(/, \}/g, ' }');
const without = (type: string | string[], drop: string): string[] =>
  (Array.isArray(type) ? type : [type]).filter((t) => t !== drop);

describe('Apify actor scaffold', () => {
  it('derives a dataset field from the record schema: nullability, arrays, anything', () => {
    const props = (
      z.toJSONSchema(
        z.object({
          id: z.string(),
          name: z.string().nullable(),
          count: z.number().int().nullable(),
          tags: z.array(z.string()),
          parts: z.array(z.object({ a: z.string() })).nullable(),
          extra: z.unknown(),
        }),
        { unrepresentable: 'any' },
      ) as { properties: Record<string, object> }
    ).properties;
    expect(datasetField(props.id)).toEqual({ type: 'string' });
    expect(datasetField(props.name)).toEqual({ type: ['string', 'null'] });
    expect(datasetField(props.count)).toEqual({ type: ['integer', 'null'] });
    expect(datasetField(props.tags)).toEqual({ type: 'array', items: { type: 'string' } });
    expect(datasetField(props.parts)).toEqual({
      type: ['array', 'null'],
      items: { type: 'object' },
    });
    expect(datasetField(props.extra).type).toContain('null');
  });

  it('agrees with the registry on which sources have a change feed', () => {
    for (const source of listSources()) expect(feedOf(source)).toBe(hasChangeFeed(source));
  });

  it('writes for every shipped dataset the fields its committed schema declares, type-compatibly', () => {
    expect(datasetSources.length).toBeGreaterThanOrEqual(17);
    const problems: string[] = [];
    let fields = 0;
    for (const source of datasetSources) {
      const actor = committed[`../apify/${source.slug}/.actor/dataset_schema.json`];
      const generated = datasetSchema(source).fields.properties;
      expect(Object.keys(generated), source.slug).toEqual(Object.keys(actor.fields.properties));
      for (const [field, prop] of Object.entries(generated)) {
        fields++;
        // The committed file may be looser (null allowed, number for an integer), never stricter.
        const declared = new Set(without(actor.fields.properties[field]?.type ?? [], 'null'));
        for (const t of without(prop.type, 'null')) {
          if (!declared.has(t) && !(t === 'integer' && declared.has('number')))
            problems.push(`${source.slug}.${field}: scaffold ${t}, committed ${[...declared]}`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
    expect(fields).toBeGreaterThan(300);
  });

  it('reproduces the schemas of the four folders built by hand since 2026-11-12 exactly', () => {
    for (const slug of [
      'uk-payment-practices',
      'uk-company-accounts',
      'uk-gender-pay-gap',
      'uk-modern-slavery-statements',
    ]) {
      const source = getSource(slug) as DataSource;
      expect(datasetSchema(source).fields.properties, slug).toEqual(
        committed[`../apify/${slug}/.actor/dataset_schema.json`].fields.properties,
      );
    }
  });

  it('writes the main.mjs call each committed folder makes', () => {
    for (const source of datasetSources) {
      const main = mains[`../apify/${source.slug}/src/main.mjs`] ?? '';
      const call = /await runDatasetActor\([\s\S]*?\);/.exec(mainModule(source))?.[0] ?? 'none';
      expect(squash(main), source.slug).toContain(squash(call));
    }
  });

  it('gives every query param an input the schema test accepts, feed inputs only on a feed', () => {
    const source = getSource('uk-gender-pay-gap') as DataSource;
    const { schema, skipped } = inputSchema(source, 'T');
    expect(skipped).toEqual([]);
    expect(Object.keys(schema.properties).slice(0, 3)).toEqual(['mode', 'since', 'change']);
    expect(Object.keys(schema.properties).slice(-2)).toEqual(['q', 'max_results']);
    // The integer param the 2026-11-17 hand build had to leave out is offered.
    expect(schema.properties.employer_id).toMatchObject({ type: 'integer', editor: 'number' });
    expect(schema.properties.reporting_year).toMatchObject({ type: 'integer' });
    expect(schema.properties.submitted_late).toMatchObject({ type: 'boolean', editor: 'checkbox' });
    expect(schema.properties.submitted_on_after).toMatchObject({
      editor: 'textfield',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      title: 'Submitted on on or after',
    });
    expect(String(schema.properties.employer?.description)).toContain(TODO);
    const noFeed = datasetSources.find((s) => !hasChangeFeed(s)) as DataSource;
    expect(Object.keys(inputSchema(noFeed, 'T').schema.properties)).not.toContain('mode');
    expect(mainModule(noFeed)).not.toContain('mode');
  });

  it('reads filter suffixes as words in titles', () => {
    expect(titleOf('company_number')).toBe('Company number');
    expect(titleOf('net_assets_min')).toBe('Net assets at least');
    expect(titleOf('employees_max')).toBe('Employees at most');
    expect(titleOf('file_date_after')).toBe('File date on or after');
    expect(titleOf('due_before')).toBe('Due on or before');
  });

  it('writes the whole folder, marks what needs words with TODO and checks the Store limits', () => {
    const source = getSource('uk-payment-practices') as DataSource;
    const bare = scaffoldActor(source, { today: '2026-11-17' });
    expect(Object.keys(bare.files).sort()).toEqual([
      '.actor/README.md',
      '.actor/actor.json',
      '.actor/dataset_schema.json',
      '.actor/input_schema.json',
      '.actor/output_schema.json',
      'package.json',
      'src/main.mjs',
    ]);
    expect(bare.todos).toBeGreaterThan(5);
    expect(bare.readmeRow).toBe(
      '| `uk-payment-practices` | pushed by CI on the 2026-11-17 commit | https://console.apify.com/actors |',
    );
    for (const name of Object.keys(bare.files).filter((f) => f.endsWith('.json')))
      expect(() => JSON.parse(bare.files[name] ?? ''), name).not.toThrow();
    const actor = JSON.parse(bare.files['.actor/actor.json'] ?? '{}') as Record<string, string>;
    expect(actor.name).toBe('uk-payment-practices');
    expect(actor.title).toContain(TODO);

    const titled = scaffoldActor(source, {
      today: '2026-11-17',
      name: 'uk-payment-practices-reports',
      title: 'x'.repeat(TITLE_MAX),
      description: 'y'.repeat(DESCRIPTION_MAX),
    });
    expect(titled.todos).toBeLessThan(bare.todos);
    expect(titled.files['.actor/actor.json']).toContain('"uk-payment-practices-reports"');
    expect(() =>
      scaffoldActor(source, { today: '2026-11-17', title: 'x'.repeat(TITLE_MAX + 1) }),
    ).toThrow(/title is 64 chars; the Apify Store allows 63/);
    // The 304-character description of 2026-11-17 is refused when it is written, not by the push.
    expect(() =>
      scaffoldActor(source, { today: '2026-11-17', description: 'y'.repeat(304) }),
    ).toThrow(/description is 304 chars; the Apify Store allows 300/);
    expect(() => scaffoldActor(source, { today: '2026-11-17', name: 'Not A Slug' })).toThrow(
      /lowercase words joined by hyphens/,
    );
    const lookup = listSources().find((s) => s.lookup !== undefined) as DataSource;
    expect(() => scaffoldActor(lookup, { today: '2026-11-17' })).toThrow(/lookup source/);
  });
});
