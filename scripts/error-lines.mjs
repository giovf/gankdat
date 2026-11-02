// The Worker's error-level lines of the last day, printed to the job log and nothing written
// (foundry `metrics-probe-dispatch`, 2026-11-02). The `gankdat metrics` workflow runs this on a
// `probe: true` dispatch — the live MCP probe and this reading, ≤ 1 min, no install, no Daily
// numbers row, no commit — because 19 of the 26 metrics runs in the week to 11-02 were dispatches
// made for a probe or a log read after a push, each billing the full 4–5 min pass (84 of the job's
// 91 minutes). The Daily numbers job prints the same lines (src/lib/error-lines.ts
// `errorLinesReport`) before it writes the row's `worker errors 24h:` clause.
//
//   CLOUDFLARE_API_TOKEN=… node --disable-warning=ExperimentalWarning ventures/gankdat/scripts/error-lines.mjs [--hours=24]
//
// Exit 0 with the lines (or a `worker errors body:` head when there are none), 1 only when the
// token is missing or the API refuses (a 403 names the missing Workers Observability Read scope).

import {
  ERROR_LOG_HOURS,
  errorLinesReport,
  errorLogQuery,
  foldErrorLines,
} from '../src/lib/error-lines.ts';
import { WAVE_LOG_QUERY_PATH } from '../src/lib/wave-logs.ts';

const ACCOUNT_ID = '37e56f3ce4dfe49919e85d4380467f44'; // not a secret

/** `--key=value` flags (npm_config_<key> too, for `npm run … -- --key=value`). */
function flag(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (arg) return arg.slice(name.length + 3);
  const env = process.env[`npm_config_${name}`];
  return env === undefined || env === '' ? fallback : env;
}

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN missing');
  process.exit(1);
}
const hours = Math.max(1, Math.min(168, Number(flag('hours', ERROR_LOG_HOURS)) || ERROR_LOG_HOURS));

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}${WAVE_LOG_QUERY_PATH}`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(errorLogQuery(Date.now(), hours)),
  },
);
const text = await res.text();
if (!res.ok) {
  console.error(
    `HTTP ${res.status}${res.status === 403 ? ' (token lacks Workers Observability Read)' : ` ${text.replace(/\s+/g, ' ').slice(0, 160)}`}`,
  );
  process.exit(1);
}
for (const line of errorLinesReport(foldErrorLines(JSON.parse(text)), text, hours))
  console.log(line);
