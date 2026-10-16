#!/usr/bin/env node
// Runner-side x402 probe payment (plain Node like metrics.mjs; the typed parts are in ./x402-bazaar-read.ts)
// (gankdat `metrics-bazaar-merchant-read`, 2026-10-14; action 026
// option B): when the owner funded a US$1 buyer wallet and saved its key as the repository secret
// `X402_PROBE_KEY`, the `gankdat metrics` job runs this before the Daily numbers row and repeats the
// settled half-cent call that indexes (and keeps alive) gankdat's routes in the x402 Bazaar —
// `shouldProbe` in ./x402-bazaar-read.ts says when (never twice in 7 days; the `0 listed` clause,
// the 1st of the month, or the `x402_probe` dispatch input). The call itself is the test client
// (`scripts/x402-test-client.mjs`, UA `gankdat-x402-probe/…`, counted as internal by metrics.mjs).
// The key reaches the child through the environment only; nothing here prints or stores it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shouldProbe } from './x402-bazaar-read.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const research = readFileSync(path.join(here, '..', 'RESEARCH.md'), 'utf8');
const decision = shouldProbe({
  hasKey: (process.env.PRIVATE_KEY ?? '').trim().length > 0,
  forced: /^(true|1|yes)$/i.test((process.env.X402_PROBE_FORCE ?? '').trim()),
  today: new Date().toISOString().slice(0, 10),
  research,
});
console.log(`x402 probe: ${decision.pay ? 'paying' : 'skipped'} — ${decision.reason}`);
if (!decision.pay) process.exit(0);

const client = path.join(here, 'x402-test-client.mjs');
const run = spawnSync(process.execPath, [client], { stdio: 'inherit', env: process.env });
process.exit(run.status ?? 1);
