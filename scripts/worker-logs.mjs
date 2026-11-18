// One dispatch reads a Worker log (foundry `worker-logs-dispatch-job`, 2026-10-29). Every Worker-side
// cause this week was read by dispatching the Daily numbers job and reading its log — nine two-minute
// runs on 10-27 and 10-29, each appending a row to RESEARCH.md and pushing a commit — because no
// sandbox can call the Cloudflare API (the token lives in Actions secrets). This script is what the
// `worker logs` workflow (docs/ci/worker-logs.yml → .github/workflows/) runs: it asks Workers Logs
// (Query Builder, the same endpoint and filters as wave-logs.ts) for the gankdat Worker's lines in a
// window, narrowed by a request id, a level and/or a needle (a path, a slug, a message fragment), and
// prints them — one folded line per event, then the raw events as JSON — to the job log, which the
// routine reads with the GitHub MCP `get_job_logs`. Nothing is written or committed.
//
//   CLOUDFLARE_API_TOKEN=… node ventures/gankdat/scripts/worker-logs.mjs \
//     [--needle=/v1/uk-company-profiles] [--request-id=…] [--level=error] [--since-minutes=60] [--limit=50]
//
// Exit 0 with lines (or `no lines`), 1 only when the API refuses or the token is missing.
//
// Completeness (gankdat `worker-logs-read-completeness`, 2026-11-18, src/lib/log-read.ts): the head
// of the output is `log read: N returned of M matched — complete | PARTIAL: <why>` and `log store:
// … sample interval S`. A window the database answered from sampled data (ABR level above 1) is
// halved and read again, more matches than a page are followed by cursor up to --limit (max 5000),
// and what still falls short is named — `no lines` under a PARTIAL head is not absence.
// The workflow passes its inputs as WORKER_LOGS_* env vars, so a needle with double quotes
// (`"event":"x402_init_failed"`) survives the shell; a flag still wins when both are given.

import { WAVE_LOG_QUERY_PATH, WAVE_LOG_SERVICE, parseWaveLogEvents } from '../src/lib/wave-logs.ts';
import {
  logReadLine,
  readLogEvents,
  storedCountLine,
  storedCountOf,
  storedCountQuery,
} from '../src/lib/log-read.ts';

const ACCOUNT_ID = '37e56f3ce4dfe49919e85d4380467f44'; // not a secret
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

/** `--key=value` flags (npm_config_<key> too, for `npm run … -- --key=value`). */
function flag(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (arg) return arg.slice(name.length + 3);
  const key = name.replaceAll('-', '_');
  const env = process.env[`npm_config_${key}`] || process.env[`WORKER_LOGS_${key.toUpperCase()}`];
  return env === undefined || env === '' ? fallback : env;
}

/** The Query Builder body for the window and the narrowing flags; exported for the test. */
export function workerLogsQuery({ needle, requestId, level, sinceMinutes, limit, nowMs }) {
  const filters = [
    { key: '$metadata.service', operation: 'eq', value: WAVE_LOG_SERVICE, type: 'string' },
  ];
  if (requestId)
    filters.push({ key: '$metadata.requestId', operation: 'eq', value: requestId, type: 'string' });
  if (level)
    filters.push({ key: '$metadata.level', operation: 'eq', value: level, type: 'string' });
  return {
    queryId: 'worker-logs-dispatch',
    timeframe: { from: nowMs - sinceMinutes * 60 * 1000, to: nowMs },
    parameters: {
      datasets: ['cloudflare-workers'],
      filters,
      ...(needle ? { needle: { value: needle, isRegex: false, matchCase: false } } : {}),
      calculations: [],
      groupBys: [],
    },
    view: 'events',
    limit,
  };
}

/** `at | level | message` for one folded event. */
export function foldedLine(ev) {
  return `${ev.at} | ${ev.level} | ${ev.message}`;
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error('worker-logs: CLOUDFLARE_API_TOKEN is not set');
    process.exit(1);
  }
  const options = {
    needle: flag('needle', ''),
    requestId: flag('request-id', ''),
    level: flag('level', ''),
    sinceMinutes: Math.max(1, Number(flag('since-minutes', '60')) || 60),
    limit: Math.min(5000, Math.max(1, Number(flag('limit', '50')) || 50)),
    nowMs: Date.now(),
  };
  const query = workerLogsQuery(options);
  console.log(
    `worker-logs: ${WAVE_LOG_SERVICE}, last ${options.sinceMinutes} min` +
      (options.needle ? `, needle "${options.needle}"` : '') +
      (options.requestId ? `, requestId ${options.requestId}` : '') +
      (options.level ? `, level ${options.level}` : '') +
      `, limit ${options.limit}`,
  );
  const post = async (q) => {
    const res = await fetch(`${API}${WAVE_LOG_QUERY_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(q),
    });
    const bodyText = await res.text();
    if (!res.ok) {
      const hint = res.status === 403 ? ' (token lacks Workers Observability Read)' : '';
      throw new Error(`HTTP ${res.status}${hint}: ${bodyText.slice(0, 400)}`);
    }
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new Error(`unparseable body: ${bodyText.slice(0, 400)}`);
    }
  };
  let read;
  try {
    read = await readLogEvents(post, query, options.limit);
  } catch (err) {
    console.error(`worker-logs: ${err.message}`);
    process.exit(1);
  }
  console.log(logReadLine(read.stats));
  // What the store holds for the same filters: a sample interval above 1 is loss at ingest. Its
  // refusal is one line and never stops the read.
  try {
    console.log(storedCountLine(storedCountOf(await post(storedCountQuery(query)))));
  } catch (err) {
    console.log(storedCountLine(null, String(err.message).replace(/\s+/g, ' ').slice(0, 200)));
  }
  const body = read.body;
  const events = parseWaveLogEvents(body);
  if (events.length === 0) {
    console.log('no lines');
  } else {
    console.log(`${events.length} line(s), newest first:`);
    for (const ev of events) console.log(`  ${foldedLine(ev)}`);
  }
  console.log('--- raw events (JSON) ---');
  console.log(JSON.stringify(read.events, null, 1));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) await main();
