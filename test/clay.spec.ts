import { describe, expect, it } from 'vitest';
import { getSource, listSources } from '../src/sources/registry';
import headers from '../public/_headers?raw';
import clayHtml from '../public/clay.html?raw';
import indexHtml from '../public/index.html?raw';
import sitemap from '../public/sitemap.xml?raw';
import skillMd from '../skills/uk-company-register-check/SKILL.md?raw';

/**
 * gankdat in Clay (queue `clay-http-api-listing`, 2026-11-09): a docs page of HTTP API column
 * configurations and an Agent Skill, both calling the live `/v1/data/<source>` routes with the
 * user's own key. Nothing runs here against Clay — what this spec pins is that every source,
 * query parameter, field path and rate limit the page and the Skill quote is real, so a renamed
 * parameter or field in a source file fails the gate instead of breaking a Clay user's column
 * silently; plus the shelf couplings (sitemap row, CSP rows, landing card).
 */

interface ColumnConfig {
  source: string;
  params: string[];
  fields: string[];
  rate: number;
}

function columnConfigs(html: string): ColumnConfig[] {
  const configs: ColumnConfig[] = [];
  const re =
    /<dl\s+class="config"\s+data-source="([^"]+)"\s+data-params="([^"]+)"\s+data-fields="([^"]+)"\s+data-rate="(\d+)"/g;
  for (const m of html.matchAll(re)) {
    configs.push({
      source: m[1]!,
      params: m[2]!.split(','),
      fields: m[3]!.split(','),
      rate: Number(m[4]),
    });
  }
  return configs;
}

/** Top-level keys of a source's record schema (every source declares a zod object). */
function recordFields(slug: string): Set<string> {
  const source = getSource(slug)!;
  const schema = source.recordSchema as unknown as { shape?: Record<string, unknown> };
  return new Set(Object.keys(schema.shape ?? {}));
}

const configs = columnConfigs(clayHtml);

describe('Clay docs page (public/clay.html)', () => {
  it('documents five columns, each on a registered source', () => {
    expect(configs).toHaveLength(5);
    for (const c of configs) {
      expect(getSource(c.source), c.source).toBeDefined();
      expect(clayHtml).toContain(`https://gankdat.com/v1/data/${c.source}`);
      expect(clayHtml).toContain(`href="/stats/${c.source}"`);
    }
  });

  it('maps only query parameters the source accepts', () => {
    for (const c of configs) {
      const accepted = Object.keys(getSource(c.source)!.queryParams.shape);
      for (const p of c.params) {
        expect(accepted, `${c.source} ?${p}`).toContain(p);
      }
    }
  });

  it('returns only field paths that exist on the record', () => {
    for (const c of configs) {
      const fields = recordFields(c.source);
      expect(fields.size, c.source).toBeGreaterThan(0);
      for (const f of c.fields) {
        expect(fields.has(f), `${c.source} data.0.${f}`).toBe(true);
        expect(clayHtml).toContain(`data.0.${f}`);
      }
    }
  });

  it('quotes each source’s real per-minute rate limit', () => {
    for (const c of configs) {
      const limit = getSource(c.source)!.rateLimit ?? { limit: 60, windowSeconds: 60 };
      expect(limit.windowSeconds).toBe(60);
      expect(c.rate, c.source).toBe(limit.limit);
      expect(clayHtml).toContain(`Request limit <code>${limit.limit}</code>`);
    }
  });

  it('is a lookup-by-key page: the company record is keyed by one of its lookup keys', () => {
    const profiles = getSource('uk-company-profiles')!;
    const config = configs.find((c) => c.source === 'uk-company-profiles')!;
    for (const p of config.params) {
      expect(profiles.lookup!.keys).toContain(p);
    }
  });

  it('is linked from the sitemap, the landing page and carries the strict CSP', () => {
    expect(sitemap).toContain('<url><loc>https://gankdat.com/clay</loc></url>');
    expect(indexHtml).toContain('href="/clay"');
    for (const path of ['/clay', '/clay.html']) {
      const rule = headers.split(`\n${path}\n`)[1]?.split('\n\n')[0] ?? '';
      expect(rule, path).toContain("script-src 'self';");
      expect(rule, path).not.toContain('unsafe-eval');
    }
  });

  it('states what the row is not (Blind Mode) and the credit price', () => {
    expect(clayHtml).toMatch(/What it is not: a contact finder/);
    expect(clayHtml).toContain('250 a month');
    expect(clayHtml).toContain('£5 per 1,000');
  });
});

describe('uk-company-register-check Skill', () => {
  it('has the Agent Skills frontmatter', () => {
    expect(skillMd.startsWith('---\nname: uk-company-register-check\ndescription: ')).toBe(true);
  });

  it('calls only registered sources with parameters they accept', () => {
    const calls = [...skillMd.matchAll(/\/v1\/data\/([a-z0-9-]+)\?([a-z_]+)=/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    const slugs = new Set(listSources().map((s) => s.slug));
    for (const [, slug, param] of calls) {
      expect(slugs.has(slug!), slug).toBe(true);
      expect(Object.keys(getSource(slug!)!.queryParams.shape), `${slug} ?${param}`).toContain(
        param,
      );
    }
    for (const c of configs) {
      expect(skillMd, `Skill covers ${c.source}`).toContain(`/v1/data/${c.source}`);
    }
  });

  it('reads the key from the environment and never asks for it in chat', () => {
    expect(skillMd).toContain('GANKDAT_API_KEY');
    expect(skillMd).toMatch(/never paste a key into the conversation/i);
    expect(skillMd).toMatch(/not a contact finder|returns none/i);
  });
});
