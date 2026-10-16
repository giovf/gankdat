import { Actor } from 'apify';
import { runDatasetActor } from './gankdat.mjs';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { max_results: maxResults = 1000, mode, since, change, ...filters } = input;
await runDatasetActor('uk-gambling-operators', filters, Number(maxResults), {
  mode,
  since,
  change,
});
await Actor.exit();
