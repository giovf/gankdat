#!/usr/bin/env node
// Self-heal the Worker's cron triggers. Interactive sessions arm TEMPORARY triggers to force
// a refresh wave; if such a session is cut off (usage limit, crash) before restoring them, the
// temporary trigger would fire every day. This compares the live schedules with wrangler.jsonc
// and resets them when they differ. Runs daily in CI (gankdat metrics job) and by hand:
//   node --env-file=.env scripts/schedules.mjs check|reset
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT_ID = '37e56f3ce4dfe49919e85d4380467f44';
const SCRIPT = 'faceless-api';
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN missing');
  process.exit(1);
}
const mode = process.argv[2] ?? 'check';
const cfg = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.jsonc'),
  'utf8',
);
const wanted =
  [...cfg.matchAll(/"crons":\s*\[([^\]]*)\]/g)][0]?.[1]
    .match(/"[^"]+"/g)
    ?.map((s) => s.slice(1, -1)) ?? [];
const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/${SCRIPT}/schedules`;
const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const live =
  (await (await fetch(url, { headers })).json()).result?.schedules?.map((s) => s.cron) ?? [];
const same = live.length === wanted.length && wanted.every((c) => live.includes(c));
console.log(
  `live: ${JSON.stringify(live)}\nwanted: ${JSON.stringify(wanted)}\n${same ? 'in sync' : 'DRIFT'}`,
);
if (!same && mode === 'reset') {
  const res = await (
    await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(wanted.map((cron) => ({ cron }))),
    })
  ).json();
  console.log(
    res.success
      ? 'reset to wrangler.jsonc'
      : `reset failed: ${JSON.stringify(res.errors).slice(0, 200)}`,
  );
  process.exit(res.success ? 0 : 1);
}
process.exit(same || mode === 'reset' ? 0 : 3);
