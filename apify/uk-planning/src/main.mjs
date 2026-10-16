import { Actor } from 'apify';
import { runDatasetActor } from './gankdat.mjs';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { max_results: maxResults = 1000, ...filters } = input;
await runDatasetActor('uk-planning', filters, Number(maxResults));
await Actor.exit();
