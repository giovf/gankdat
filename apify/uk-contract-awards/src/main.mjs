import { Actor } from 'apify';
import { runDatasetActor } from './gankdat.mjs';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { max_results: maxResults = 1000, ...filters } = input;
await runDatasetActor('uk-contract-awards', filters, Number(maxResults));
await Actor.exit();
