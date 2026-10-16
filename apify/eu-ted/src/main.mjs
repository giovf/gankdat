import { Actor } from 'apify';
import { runDatasetActor } from './gankdat.mjs';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { max_results: maxResults = 1000, ...filters } = input;
await runDatasetActor('eu-ted', filters, Number(maxResults));
await Actor.exit();
