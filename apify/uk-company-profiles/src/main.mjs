import { Actor } from 'apify';
import { runLookupActor } from './gankdat.mjs';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
const { companies = [], max_results: maxResults = 1000, mode = 'data' } = input;
// A Companies House number (digits, or a two-letter prefix and digits) is looked up as one;
// anything else is treated as a company name and resolved to the best search match.
const keyOf = (value) => (/^[A-Za-z]{0,2}\d{1,8}$/.test(value) ? 'company_number' : 'company');
await runLookupActor('uk-company-profiles', keyOf, companies, Number(maxResults), { mode });
await Actor.exit();
