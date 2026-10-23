#!/usr/bin/env node
// Runner-side x402 probe payments (plain Node like metrics.mjs; the typed parts are in
// ./x402-bazaar-read.ts) (gankdat `metrics-bazaar-merchant-read`, 2026-10-14; action 026 option B;
// per route since `x402-bazaar-week-1-index-check`, 2026-10-23): with the owner's US$1 buyer wallet
// saved as the repository secret `X402_PROBE_KEY`, the `gankdat metrics` job runs this before the
// Daily numbers row. CDP indexes ONE RESOURCE PER SETTLED PAYMENT and drops a resource 30 days
// after its last settlement (docs.cdp.coinbase.com/x402/seller/get-discovered, read 2026-10-23;
// a week after the first half-cent call only uk-tenders, the route it paid, was listed of 17), so
// `shouldProbe` says whether today reads the catalogue at all (never twice in 7 days, a 30-day cap
// of 20 half-cents) and `probeTargets` names the routes due: every unlisted route, every listed
// route whose last settlement is 23 days old, or all of them on the `x402_probe` dispatch input.
// Each payment is the test client (`scripts/x402-test-client.mjs`, UA `gankdat-x402-probe/…`,
// counted as internal by metrics.mjs) with X402_TARGET set to the route; the client prints the
// facilitator's Bazaar verdict (`success`, `processing`, `rejected`) from the settle response.
// The key reaches the child through the environment only; nothing here prints or stores it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROBE_MONTHLY_CAP,
  ownProbePayments,
  probeTargets,
  routeUrl,
  shouldProbe,
} from './x402-bazaar-read.ts';
import {
  readExampleQuery,
  readLiveSlugs,
  readMerchantCatalogue,
  readPayTo,
} from './x402-catalogue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = (process.env.PUBLIC_BASE_URL || 'https://gankdat.com').replace(/\/+$/, '');
const today = new Date().toISOString().slice(0, 10);
const research = readFileSync(path.join(here, '..', 'RESEARCH.md'), 'utf8');
const forced = /^(true|1|yes)$/i.test((process.env.X402_PROBE_FORCE ?? '').trim());
const decision = shouldProbe({
  hasKey: (process.env.PRIVATE_KEY ?? '').trim().length > 0,
  forced,
  today,
  research,
});
console.log(
  `x402 probe: ${decision.pay ? 'reading the catalogue' : 'skipped'} — ${decision.reason}`,
);
if (!decision.pay) process.exit(0);

const slugs = await readLiveSlugs(base);
const payTo = await readPayTo(base, slugs[0], 'gankdat-x402-probe/2 (+https://gankdat.com)');
const resources = await readMerchantCatalogue(payTo);
const due = probeTargets({ slugs, resources, base, today, forced });
const budget = Math.max(0, PROBE_MONTHLY_CAP - ownProbePayments(research, today));
const targets = due.slice(0, budget);
console.log(
  `x402 probe: ${resources.length} of ${slugs.length} routes listed; ${due.length} due` +
    (targets.length < due.length
      ? ` (${targets.length} within the 30-day cap of ${PROBE_MONTHLY_CAP})`
      : '') +
    (due.length ? ': ' + due.map((t) => `${t.slug} (${t.reason})`).join(', ') : ''),
);
if (!targets.length) {
  console.log('x402 probe: nothing to pay — every route is listed and settled within 23 days');
  process.exit(0);
}

const client = path.join(here, 'x402-test-client.mjs');
const paid = [];
const failed = [];
const UA = 'gankdat-x402-probe/2 (+https://gankdat.com)';
for (const target of targets) {
  console.log(`\n--- ${target.slug} (${target.reason}) ---`);
  // The declared example query (what the Bazaar's indexer sends): a lookup route needs its key.
  const query = await readExampleQuery(base, target.slug, UA).catch(() => null);
  const run = spawnSync(process.execPath, [client], {
    stdio: 'inherit',
    env: { ...process.env, X402_TARGET: routeUrl(base, target.slug, query) },
  });
  (run.status === 0 ? paid : failed).push(target.slug);
  // The facilitator settles one transfer per call; a short gap keeps the receipts readable.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
console.log(
  `\nx402 probe: paid ${paid.length} of ${targets.length} route(s)` +
    (failed.length ? `; failed: ${failed.join(', ')}` : '') +
    ` — the catalogue indexes within 15 minutes; tomorrow's \`bazaar:\` clause is the proof`,
);
process.exit(paid.length ? 0 : 1);
