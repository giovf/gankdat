import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/lib/constants';
import { listSources } from '../src/sources/registry';
import functionsJs from '../public/addin/functions.js?raw';
import functionsJson from '../public/addin/functions.json?raw';
import headers from '../public/_headers?raw';
import helpHtml from '../public/addin.html?raw';
import manifest from '../public/addin/manifest.xml?raw';
import sitemap from '../public/sitemap.xml?raw';
import taskpaneHtml from '../public/addin/taskpane.html?raw';
import taskpaneJs from '../public/js/addin-taskpane.js?raw';

/**
 * gankdat for Excel (AppSource shelf item, 2026-10-24): the add-in is static files under
 * public/addin/ plus one task-pane script. Nothing here runs Office.js — the Office runtime is
 * the only place that can — so this spec pins the certification facts a reviewer checks and the
 * couplings a later edit could break silently: every file the manifest names is on this domain
 * (policy 1120.5.2), every custom function declared in functions.json is associated in
 * functions.js and documented on the help page, no mobile form factor is declared (1120.2 bans
 * purchase UI there and the pane sells keys), helpUrl is set (1120.5), and the manifest version
 * follows APP_VERSION.
 */

const PAGE_FILES = [
  'functions.js',
  'functions.html',
  'functions.json',
  'taskpane.html',
  'commands.html',
];

interface FunctionsMetadata {
  functions: {
    id: string;
    name: string;
    helpUrl?: string;
    parameters: { name: string; type: string; optional?: boolean }[];
  }[];
}

const metadata = JSON.parse(functionsJson) as FunctionsMetadata;

describe('Excel add-in manifest', () => {
  it('names only https://gankdat.com/addin/ files (same-domain hosting, policy 1120.5.2)', () => {
    const urls = [...manifest.matchAll(/DefaultValue="(https?:[^"]+)"/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(8);
    for (const url of urls) {
      expect(url, url).toMatch(/^https:\/\/gankdat\.com\//);
    }
    for (const file of PAGE_FILES) {
      expect(urls).toContain(`https://gankdat.com/addin/${file}`);
    }
    expect(urls).toContain('https://gankdat.com/addin'); // Help.Url = the help page (no trailing slash: canonical.ts strips them)
    expect(urls).toContain('https://gankdat.com/feedback'); // SupportUrl
  });

  it('declares the custom functions runtime, a ribbon command and no mobile form factor', () => {
    expect(manifest).toContain('<Set Name="CustomFunctionsRuntime" MinVersion="1.1" />');
    expect(manifest).toContain('xsi:type="CustomFunctions"');
    expect(manifest).toContain('xsi:type="PrimaryCommandSurface"'); // add-in commands (1120.5.4)
    expect(manifest).toContain('<DesktopFormFactor>');
    expect(manifest).not.toContain('MobileFormFactor');
    expect(manifest).not.toContain('<Host Name="Mobile');
    expect(manifest).toContain('<bt:String id="Functions.Namespace" DefaultValue="GANKDAT" />');
  });

  it('tracks APP_VERSION with a fourth segment', () => {
    expect(manifest).toContain(`<Version>${APP_VERSION}.0</Version>`);
  });

  it('keeps the description inside the manifest limit (250 chars)', () => {
    const description = /<Description DefaultValue="([^"]+)"/.exec(manifest)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(250);
  });
});

describe('custom functions metadata', () => {
  it('lists the six functions, each with a helpUrl on the help page (policy 1120.5)', () => {
    const ids = metadata.functions.map((f) => f.id);
    expect(ids).toEqual(['UKCOMPANY', 'UKCHARITY', 'CQC', 'SANCTIONS', 'TENDERS', 'QUERY']);
    for (const fn of metadata.functions) {
      expect(fn.name).toBe(fn.id);
      expect(fn.helpUrl, fn.id).toMatch(/^https:\/\/gankdat\.com\/addin#[a-z]+$/);
      const anchor = fn.helpUrl!.split('#')[1]!;
      expect(helpHtml, `help anchor for ${fn.id}`).toContain(`id="${anchor}"`);
      expect(helpHtml).toContain(`=GANKDAT.${fn.id}(`);
      expect(fn.parameters.length).toBeGreaterThan(0);
      // Required parameters first, optional ones last — Excel's rule for the signature.
      const firstOptional = fn.parameters.findIndex((p) => p.optional === true);
      if (firstOptional >= 0) {
        expect(fn.parameters.slice(firstOptional).every((p) => p.optional === true)).toBe(true);
      }
    }
  });

  it('is associated in functions.js under the same ids', () => {
    for (const fn of metadata.functions) {
      expect(functionsJs).toContain(`CustomFunctions.associate('${fn.id}', `);
    }
    const associated = [...functionsJs.matchAll(/CustomFunctions\.associate\('([A-Z]+)'/g)].map(
      (m) => m[1],
    );
    expect(associated.sort()).toEqual(metadata.functions.map((f) => f.id).sort());
  });

  it('calls only the metered REST route on the API host, with the stored key', () => {
    expect(functionsJs).toContain("var API_BASE = 'https://gankdat.com'");
    expect(functionsJs).toContain("'/v1/data/'");
    expect(functionsJs).toContain('OfficeRuntime.storage.getItem(KEY_STORAGE)');
    expect(functionsJs).not.toContain('/mcp'); // the preview budget is the pane's, never a formula's
  });

  it('names registered datasets only', () => {
    const slugs = new Set(listSources().map((s) => s.slug));
    for (const slug of [
      'uk-company-profiles',
      'uk-charities',
      'uk-care-locations',
      'uk-sanctions',
      'uk-tenders',
    ]) {
      expect(functionsJs).toContain(`'${slug}'`);
      expect(slugs.has(slug), slug).toBe(true);
    }
    const paneSlugs = [...taskpaneHtml.matchAll(/<option value="([a-z0-9-]+)"/g)].map((m) => m[1]!);
    expect(paneSlugs.length).toBeGreaterThan(10);
    for (const slug of paneSlugs) expect(slugs.has(slug), slug).toBe(true);
  });
});

describe('task pane', () => {
  it('shows the preview before the key step and names the MCP preview tool shape', () => {
    expect(taskpaneHtml.indexOf('Try a register')).toBeLessThan(
      taskpaneHtml.indexOf('Add your API key'),
    );
    expect(taskpaneJs).toContain("'query_' + source.replace(/-/g, '_')");
    expect(taskpaneJs).toContain('per_page: 5');
    expect(taskpaneJs).toContain('setItem(KEY_STORAGE, key)');
    // Every page script is a file (strict CSP), nothing inline.
    expect(taskpaneHtml).not.toMatch(/<script>[^<]/);
  });

  it('is allowed to run inside Office frames and load Office.js (per-page CSP)', () => {
    for (const path of [
      '/addin/taskpane.html',
      '/addin/functions.html',
      '/addin/commands.html',
      '/addin',
      '/addin.html',
    ]) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const block = new RegExp(`^${escaped}\\n((?: {2}.*\\n?)+)`, 'm').exec(headers)?.[1];
      expect(block, path).toBeDefined();
      expect(block).toContain('! X-Frame-Options');
      expect(block).toContain('https://appsforoffice.microsoft.com');
      expect(block).toContain('frame-ancestors https://');
    }
  });

  it('is in the sitemap through its help page', () => {
    expect(sitemap).toContain('<url><loc>https://gankdat.com/addin</loc></url>');
  });
});
