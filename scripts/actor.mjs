// Writes apify/<slug>/ for a registered dataset source (foundry `gankdat-actor-scaffold`,
// 2026-11-17): the dataset schema and the input schema derived from the source's zod schemas,
// main.mjs, package.json, the shared client and Dockerfile copied from a shipped folder, and the
// row in apify/README.md.
//
//   npm run actor -- <slug> [--name <store-name>] [--title "<≤ 63>"] [--description "<≤ 300>"]
//                           [--dir <folder, default apify>] [--force]
//   (esbuild bundles this file with src/apify/scaffold.ts and the registry, then runs it)
//
// Every line that needs the builder's words (README, filter descriptions, a title or description
// not passed) is written with TODO; test/apify-schemas.spec.ts fails until none is left, so the
// folder cannot be pushed half-written. A title or description over the Store's limit is refused
// here. An existing folder is never overwritten without --force.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import prettier from 'prettier';
import { scaffoldActor } from '../src/apify/scaffold.ts';
import { getSource, listSources } from '../src/sources/registry.ts';

/** Files every single-source actor shares byte for byte (test/apify-schemas.spec.ts). */
const SHARED = ['Dockerfile', 'src/gankdat.mjs'];
/** The merged lead feed keeps its own client; never copy from it. */
const NOT_CANONICAL = 'uk-no-website-leads';

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') flags.force = true;
    else if (arg.startsWith('--')) flags[arg.slice(2)] = argv[++i];
    else rest.push(arg);
  }
  return { slug: rest[0], flags };
}

async function main() {
  const { slug, flags } = parseArgs(process.argv.slice(2));
  const source = slug ? getSource(slug) : undefined;
  if (!source) {
    console.error(
      `usage: npm run actor -- <slug> [--name n] [--title t] [--description d] [--dir apify] [--force]\n` +
        `${slug ? `"${slug}" is not a registered source. ` : ''}Sources: ${listSources()
          .map((s) => s.slug)
          .join(', ')}`,
    );
    process.exit(1);
  }
  const root = process.cwd();
  const apify = join(root, 'apify');
  const outRoot = flags.dir ? join(root, flags.dir) : apify;
  const outDir = join(outRoot, source.slug);
  if (existsSync(outDir) && !flags.force) {
    console.error(`${outDir} exists — pass --force to overwrite its generated files`);
    process.exit(1);
  }
  const scaffold = scaffoldActor(source, {
    name: flags.name,
    title: flags.title,
    description: flags.description,
    today: new Date().toISOString().slice(0, 10),
  });
  const canonical = readdirSync(apify, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== NOT_CANONICAL && d.name !== source.slug)
    .map((d) => d.name)
    .sort()[0];
  if (!canonical) throw new Error('no shipped actor folder to copy the shared client from');

  const write = (name, text) => {
    const file = join(outDir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`wrote ${join(flags.dir ?? 'apify', source.slug, name)}`);
  };
  for (const [name, text] of Object.entries(scaffold.files)) {
    const file = join(outDir, name);
    const options = (await prettier.resolveConfig(file)) ?? {};
    const formatted = name.endsWith('.md')
      ? text
      : await prettier.format(text, { ...options, filepath: file });
    write(name, formatted);
  }
  for (const name of SHARED) write(name, readFileSync(join(apify, canonical, name), 'utf8'));

  if (!flags.dir) {
    const readmePath = join(apify, 'README.md');
    const readme = readFileSync(readmePath, 'utf8');
    if (readme.includes(`| \`${source.slug}\` |`)) {
      console.log('apify/README.md already lists the folder');
    } else {
      const lines = readme.split('\n');
      const lastRow = lines.findLastIndex((l) => l.startsWith('| `'));
      if (lastRow < 0) throw new Error('apify/README.md: no "Published actors" table row found');
      lines.splice(lastRow + 1, 0, scaffold.readmeRow);
      writeFileSync(readmePath, lines.join('\n'));
      console.log('added the row to apify/README.md');
    }
  }
  if (scaffold.skipped.length > 0)
    console.log(
      `not offered as inputs (no Apify editor for an array or object param): ${scaffold.skipped.join(', ')}`,
    );
  console.log(
    `${scaffold.todos} TODO line(s) to write (grep -rn TODO ${join(flags.dir ?? 'apify', source.slug)}); ` +
      `then trim the overview view, and npm test -- apify-schemas`,
  );
}

await main();
