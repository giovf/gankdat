import { Actor, log } from 'apify';
import { runDatasetActor } from './gankdat.mjs';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { max_results: maxResults = 1000, ...filters } = input;
try {
  await runDatasetActor('uk-planning', filters, Number(maxResults));
} catch (err) {
  // Origin paused (2026-10-19): planning.data.gov.uk emptied the dataset on 2026-10-10 and the
  // API answers 503 with its dated notice. A run that fails on that answer is what Apify's QA
  // flags as "under maintenance" (10-17) and what a buyer's schedule reports as broken, so the
  // run ends cleanly instead — no results, no charge, the notice as the status message — and
  // resumes by itself when the origin republishes. Any other failure still fails the run.
  const message = String(err?.message ?? err);
  if (!/gankdat API 503: .*Origin paused/s.test(message)) throw err;
  const notice =
    'Paused: the source register (planning.data.gov.uk planning-application) is empty since 2026-10-10; this actor resumes when it republishes. No results, nothing charged.';
  log.warning(`${notice} API said: ${message.slice(0, 300)}`);
  await Actor.setStatusMessage(notice);
}
await Actor.exit();
