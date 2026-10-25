// Renders the Power Platform certified-connector package from the source registry into
// ventures/gankdat/connector/ (gankdat `power-platform-certified-connector`, 2026-10-25).
//
//   npm run connector        (esbuild bundles this file with src/connector/render.ts, then runs it)
//
// Writes apiDefinition.swagger.json, apiProperties.json, readme.md, intro.md and icon.png
// (the raccoon from public/icon-raccoon.svg on a 230 × 230 brand-colour canvas, the logo at
// 65 % of the side — Microsoft asks for 100–230 px, a non-white background and a logo under
// 70 %). JSON goes through Prettier so the committed files pass the repo's format check;
// test/connector.spec.ts fails when the committed package no longer matches the registry.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';
import { ICON_BRAND_COLOR, renderConnector } from '../src/connector/render.ts';

const root = process.cwd();
const outDir = join(root, 'connector');
mkdirSync(outDir, { recursive: true });

const ICON_SIDE = 230;
const LOGO_SHARE = 0.65;

/** @param {string} name @param {string} text */
async function writeJson(name, text) {
  const options = (await prettier.resolveConfig(join(outDir, name))) ?? {};
  const formatted = await prettier.format(text, { ...options, filepath: join(outDir, name) });
  writeFileSync(join(outDir, name), formatted);
  console.log(`wrote connector/${name} (${formatted.length} chars)`);
}

/** The raccoon centred on a square brand-colour canvas; viewBox 22 × 20 keeps its pixel art crisp. */
function iconSvg() {
  const raccoon = readFileSync(join(root, 'public', 'icon-raccoon.svg'), 'utf8');
  const inner = raccoon.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const width = Math.round(ICON_SIDE * LOGO_SHARE);
  const height = Math.round((width * 20) / 22);
  const x = Math.round((ICON_SIDE - width) / 2);
  const y = Math.round((ICON_SIDE - height) / 2);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIDE}" height="${ICON_SIDE}" viewBox="0 0 ${ICON_SIDE} ${ICON_SIDE}">` +
    `<rect width="${ICON_SIDE}" height="${ICON_SIDE}" fill="${ICON_BRAND_COLOR}"/>` +
    `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 22 20" shape-rendering="crispEdges">${inner}</svg>` +
    `</svg>`
  );
}

async function writeIcon() {
  let Resvg;
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch {
    console.log(
      'icon.png not rendered: @resvg/resvg-js is not installed (the committed icon stands)',
    );
    return;
  }
  const png = new Resvg(iconSvg(), { fitTo: { mode: 'width', value: ICON_SIDE } }).render().asPng();
  writeFileSync(join(outDir, 'icon.png'), png);
  console.log(`wrote connector/icon.png (${ICON_SIDE} × ${ICON_SIDE}, ${png.length} bytes)`);
}

const pkg = renderConnector();
await writeJson('apiDefinition.swagger.json', JSON.stringify(pkg.swagger, null, 2));
await writeJson('apiProperties.json', JSON.stringify(pkg.apiProperties, null, 2));
writeFileSync(join(outDir, 'readme.md'), pkg.readme);
writeFileSync(join(outDir, 'intro.md'), pkg.intro);
console.log('wrote connector/readme.md and connector/intro.md');
await writeIcon();
const operations = Object.keys(pkg.swagger.paths).length;
console.log(
  `${operations} operations, title "${pkg.swagger.info.title}", host ${pkg.swagger.host}`,
);
