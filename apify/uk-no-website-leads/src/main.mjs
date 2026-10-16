import { Actor } from 'apify';
import { runLeadFeed } from './gankdat.mjs';

await Actor.init();
const input = (await Actor.getInput()) ?? {};
await runLeadFeed(input);
await Actor.exit();
