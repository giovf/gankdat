#!/usr/bin/env node
// Runner-side x402 probe payments (plain Node like metrics.mjs; the typed parts are in
// ./x402-bazaar-read.ts) (gankdat `metrics-bazaar-merchant-read`, 2026-10-14; action 026 option B;
// per route since `x402-bazaar-week-1-index-check`, 2026-10-23): with the owner's US$1 buyer wallet
// saved as the repository secret `X402_PROBE_KEY`, the `gankdat metrics` job runs this before the
// Daily numbers row. CDP indexes ONE RESOURCE PER SETTLED PAYMENT and drops a resource 30 days
// after its last settlement (docs.cdp.coinbase.com/x402/seller/get-discovered, read 2026-10-23;
// a week after the first half-cent call only uk-tenders, the route it paid, was listed of 17), so
// `shouldProbe` says whether today reads the catalogue at all (never twice in 7 days, a 30-day cap
// of one payment per live route plus three re-screens — `probeMonthlyCap`, 2026-11-08) and
// `probeTargets` names the routes due: every unlisted route and every listed route whose last
// settlement is 23 days old. The `x402_probe` dispatch input (`X402_PROBE_FORCE=true`) pays those
// due routes today whatever the spacing and the cap say — the shape `x402-change-routes-bazaar-index`
// needed on 2026-11-08, when the nine change feeds priced on 11-05 sat unlisted behind a cap the
// 10-23 survey had spent; `X402_PROBE_FORCE=all` pays every route (a re-screen after a metadata
// change is per resource too).
// Each payment is the test client (`scripts/x402-test-client.mjs`, UA `gankdat-x402-probe/…`,
// counted as internal by metrics.mjs) with X402_TARGET set to the route; the client prints the
// facilitator's Bazaar verdict (`success`, `processing`, `rejected`) from the settle response.
// The key reaches the child through the environment only; nothing here prints or stores it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ownProbePayments,
  probeMonthlyCap,
  probeTargets,
  routeUrl,
  shouldProbe,
} from './x402-bazaar-read.ts';
import {
  readExampleQuery,
  readLiveChangeSlugs,
  readLiveSlugs,
  readMerchantCatalogue,
  readPayTo,
} from './x402-catalogue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = (process.env.PUBLIC_BASE_URL || 'https://gankdat.com').replace(/\/+$/, '');
const today = new Date().toISOString().slice(0, 10);
const research = readFileSync(path.join(here, '..', 'RESEARCH.md'), 'utf8');
const force = (process.env.X402_PROBE_FORCE ?? '').trim().toLowerCase();
const forced = /^(true|1|yes|all)$/.test(force);
const all = force === 'all';
const hasKey = (process.env.PRIVATE_KEY ?? '').trim().length > 0;
if (!hasKey) {
  console.log(`x402 probe: skipped — ${shouldProbe({ hasKey, forced, today, research }).reason}`);
  process.exit(0);
}

// The live routes first (keyless): the cap is one payment per route plus three re-screens.
const slugs = await readLiveSlugs(base);
const changeSlugs = await readLiveChangeSlugs(base).catch(() => []);
const routes = slugs.length + changeSlugs.length;
const decision = shouldProbe({ hasKey, forced, today, research, routes });
console.log(
  `x402 probe: ${decision.pay ? 'reading the catalogue' : 'skipped'} — ${decision.reason}`,
);
if (!decision.pay) process.exit(0);

const payTo = await readPayTo(base, slugs[0], 'gankdat-x402-probe/2 (+https://gankdat.com)');
const resources = await readMerchantCatalogue(payTo);
const due = probeTargets({ slugs, changeSlugs, resources, base, today, all });
// A forced dispatch pays every due route (bounded by the route count, ≤ US$0.20 at 25 routes);
// the weekly probe stays inside the 30-day cap.
const cap = probeMonthlyCap(routes);
const budget = forced ? due.length : Math.max(0, cap - ownProbePayments(research, today));
const targets = due.slice(0, budget);
// A data route is half a cent, a change feed one cent (X402_CHANGES_PRICE_USD, 2026-11-05).
const usd = (list) =>
  list.reduce((sum, t) => sum + (t.slug.startsWith('changes/') ? 0.01 : 0.005), 0).toFixed(3);
console.log(
  `x402 probe: ${resources.length} of ${routes} routes listed; ${due.length} due` +
    (targets.length < due.length ? ` (${targets.length} within the 30-day cap of ${cap})` : '') +
    (targets.length ? ` ≈ US$${usd(targets)}` : '') +
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
  `\nx402 probe: paid ${paid.length} of ${targets.length} route(s) ≈ US$${usd(targets.filter((t) => paid.includes(t.slug)))}` +
    (failed.length ? `; failed: ${failed.join(', ')}` : '') +
    ` — the catalogue indexes within 15 minutes; tomorrow's \`bazaar:\` clause is the proof`,
);
process.exit(paid.length ? 0 : 1);
