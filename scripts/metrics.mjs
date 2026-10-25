#!/usr/bin/env node
// Daily gankdat numbers → one row in ventures/gankdat/RESEARCH.md "## Metrics" (the table the
// Foundry Ops page reads). Runs in CI (.github/workflows/gankdat-metrics.yml) with
// CLOUDFLARE_API_TOKEN; also `npm run metrics -w @foundry/gankdat` locally (reads .env).
//   accounts / paid accounts        — D1 (accounts table)
//   MCP authed calls, paywall hits  — Analytics Engine gankdat_traffic (last 24 h)
//   x402 paid requests              — Analytics Engine (last 24 h)
//   refresh health                  — D1 refresh_log (last 24 h errors)
//   Apify actor runs / users        — Apify API (optional APIFY_TOKEN; omitted without it)

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATS_LOG_HOURS,
  STATS_LOG_LIMIT,
  crawlerNote,
  foldFamilies,
  foldStatsLogEvents,
  mcpCrawlerSql,
  statsPageLogQuery,
  zoneStatsQuery,
  zoneStatsRows,
} from '../src/lib/crawler-hits.ts';
import { afterWallNote, connectCallersNote, oauthFunnelNote } from '../src/lib/oauth-funnel.ts';
import { changesByUaNote } from '../src/lib/change-feed-callers.ts';
import { x402CallsBySlug, x402Paid30dNote, x402PaidClause } from '../src/lib/x402-sales.ts';
import { bazaarClause, bazaarResourceLines, bazaarSummary } from './x402-bazaar-read.ts';
import { readMerchantCatalogue, readPayTo } from './x402-catalogue.mjs';

const ACCOUNT_ID = '37e56f3ce4dfe49919e85d4380467f44'; // not a secret
const DATABASE_ID = 'ac051277-5f69-46ba-965b-50da2f1ec524'; // wrangler.jsonc
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN missing');
  process.exit(1);
}
const headers = { Authorization: `Bearer ${token}` };

// A push-triggered run only fills a day the 06:30 cron missed (METRICS_IF_MISSING). Before the
// refresh waves have finished (05:00–06:05 UTC, docs/SCHEDULERS.md) the day's numbers do not
// exist yet: on 2026-10-01 a 00:23 push wrote the row from the previous day's 24 h — yesterday's
// refresh errors as today's — the cron was skipped, and every later push left the row alone.
// So a fill run before the waves leaves the day missing for the cron or the next push.
const WAVES_DONE_UTC_MINUTES = 6 * 60 + 20;
{
  const now = new Date();
  if (
    process.env.METRICS_IF_MISSING &&
    now.getUTCHours() * 60 + now.getUTCMinutes() < WAVES_DONE_UTC_MINUTES
  ) {
    console.log(
      `fill-only run at ${now.toISOString().slice(11, 16)} UTC, before the refresh waves finish (06:20); leaving today's row to the 06:30 cron or a later push`,
    );
    process.exit(0);
  }
}

async function sql(query) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: query }),
    },
  );
  const body = await res.json();
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.result[0].results;
}
async function ae(query) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers,
      body: query,
    },
  );
  const body = await res.json();
  if (!body.data) throw new Error(`Analytics Engine: ${JSON.stringify(body).slice(0, 200)}`);
  return body.data;
}
const n = (rows, key) => Math.round(Number(rows[0]?.[key] ?? 0));

// Internal accounts (ours: info@, apify@ …@gankdat.com and the owner's own) are not customers.
const [acct] = await sql(
  "SELECT COUNT(*) AS total, SUM(plan != 'free') AS paid, SUM(created_at > datetime('now','-1 day')) AS new24h FROM accounts WHERE email NOT LIKE '%@gankdat.com' AND email NOT LIKE '%@1402celsius.com' AND email NOT LIKE '%@example.com' AND email NOT LIKE 'giova1506@%'",
);
// Build 2026-09-28: carry the error text, not just the slug. Twice (nhs-ods 2026-09-23, three
// sources 2026-09-28) a routine saw a slug in this row and could not fix it because refresh_log
// is not reachable from a sandbox. One line per source, whitespace collapsed, table-safe, capped;
// anything shaped like a credential in a URL is redacted before it lands in a public repo.
// An error row that a later `ok` row of the same source has already recovered from is not
// today's state (refresh-uk-insolvency-2026-10-11: the 10-10 13:00 runner 503 was still listed
// in the 10-11 row written 18 h later, right after a 1000-record refresh, and the auto-filer
// read the two rows as two failures) — only an error newer than the source's last `ok` counts.
const errors = await sql(
  "SELECT e.source_slug, MAX(e.message) AS message FROM refresh_log e WHERE e.status = 'error' AND e.created_at > datetime('now','-1 day') AND NOT EXISTS (SELECT 1 FROM refresh_log o WHERE o.source_slug = e.source_slug AND o.status = 'ok' AND o.created_at > e.created_at) GROUP BY e.source_slug",
);
// Runner-fed sources (2026-10-04, uk-insolvency) write no row at all on a day the runner job never
// ran, so any source whose last `ok` row is over two days old is listed here too, with the date:
// the row must show a refresh that died quietly, not just one that errored out loud.
const stale = await sql(
  "SELECT source_slug, MAX(CASE WHEN status = 'ok' THEN created_at END) AS last_ok FROM refresh_log WHERE created_at > datetime('now','-30 days') GROUP BY source_slug HAVING last_ok IS NULL OR last_ok < datetime('now','-2 days')",
);
// A `skipped` row (migration 0015, 2026-10-07: the resumable hash backfill that hands its rest to
// the next night) says why a stale source wrote no `ok` row, so the reading names it.
const skipped = await sql(
  "SELECT source_slug, MAX(message) AS message FROM refresh_log WHERE status = 'skipped' AND created_at > datetime('now','-1 day') GROUP BY source_slug",
);
// A night the platform killed writes no row of its own; the next attempt writes it from the
// progress marker (src/sources/progress.ts, 2026-10-18) as `silent refresh started … died after
// <phase> …`. A later `ok` row hides it from `refresh errors` — rightly, the data is fresh — so the
// phase is read here, for the day it was written, whatever followed it.
const silent = await sql(
  "SELECT source_slug, MAX(message) AS message FROM refresh_log WHERE status = 'error' AND message LIKE 'silent refresh %' AND created_at > datetime('now','-1 day') GROUP BY source_slug",
).catch(() => []);
for (const s of stale) {
  if (errors.some((e) => e.source_slug === s.source_slug)) continue;
  const skip = skipped.find((k) => k.source_slug === s.source_slug);
  errors.push({
    source_slug: s.source_slug,
    message: `no successful refresh since ${s.last_ok ? String(s.last_ok).slice(0, 10) : 'over 30 days'}${skip ? `; last run skipped: ${skip.message}` : ''}`,
  });
}
errors.sort((a, b) => a.source_slug.localeCompare(b.source_slug));
const errorText = (m) =>
  String(m ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '/')
    .replace(/([?&](?:api_key|apikey|key|token|secret|password)=)[^&\s]+/gi, '$1<redacted>')
    .trim()
    .slice(0, 90);
// Agent-side sign-up funnel (build 2026-09-25; proof: ≥ 5 keys issued via the agent path in 30
// days). Tolerant of the migration not being applied yet on the day it ships.
const agentKeys = await sql(
  "SELECT SUM(claimed_at IS NOT NULL) AS keys30d, SUM(claimed_at IS NOT NULL AND claimed_at > (strftime('%s','now') - 86400) * 1000) AS keys24h, SUM(created_at > (strftime('%s','now') - 86400) * 1000) AS requests24h FROM agent_signups WHERE email NOT LIKE '%@gankdat.com' AND email NOT LIKE '%@1402celsius.com' AND email NOT LIKE '%@example.com' AND email NOT LIKE 'giova1506@%'",
)
  .then(([row]) => row ?? null)
  .catch(() => null);
// Lazy OAuth (2026-09-30): consents = authorization codes minted for real
// accounts (internal mailboxes excluded like agent sign-up); per-client hosts
// from the oauth_token analytics point (blob4) — the "first key connected from
// claude.ai" proof of mcp-oauth-lazy-auth.
const oauth = await sql(
  "SELECT COUNT(*) AS connects30d, SUM(g.created_at > (strftime('%s','now') - 86400) * 1000) AS connects24h FROM oauth_grants g JOIN accounts a ON a.id = g.account_id WHERE g.kind = 'code' AND g.created_at > (strftime('%s','now') - 30 * 86400) * 1000 AND a.email NOT LIKE '%@gankdat.com' AND a.email NOT LIKE '%@1402celsius.com' AND a.email NOT LIKE '%@example.com' AND a.email NOT LIKE 'giova1506@%'",
)
  .then(([row]) => row ?? null)
  .catch(() => null);
const oauthClients = await ae(
  "SELECT blob4 AS client, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'oauth_token' AND blob3 = 'authorization_code' AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY client ORDER BY n DESC LIMIT 3",
).catch(() => []);
const oauthNote = oauth
  ? `oauth: ${oauth.connects24h ?? 0} connects/24h, ${oauth.connects30d ?? 0}/30d${oauthClients.length ? ` (7d by client: ${oauthClients.map((r) => `${r.client} ${Math.round(Number(r.n))}`).join(', ')})` : ''}`
  : 'oauth: n/a';
// The connect funnel (gankdat oauth-connect-funnel-check, 2026-10-09): connect_account was the
// most-wanted tool for a week with 0 connects and nothing said where the person stopped. Three
// readings over 7 days: who sends the 401s (user agents of the keyless connect_account calls —
// a scanner's UA ends the question), the challenges by reason, and every leg of routes/oauth.ts
// as `oauth_funnel` points (blob3 step, blob5 detail) so the drop-off step is a number.
const connectCallers = await ae(
  "SELECT blob2 AS ua, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'mcp_denied' AND blob5 LIKE '%connect_account%' AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY ua ORDER BY n DESC LIMIT 3",
).catch(() => []);
const challenges = await ae(
  "SELECT blob4 AS reason, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'mcp_denied' AND blob4 IN ('protected_tool', 'preview_exhausted') AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY reason ORDER BY n DESC",
).catch(() => []);
const funnelRows = await ae(
  "SELECT blob3 AS step, blob5 AS detail, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'oauth_funnel' AND timestamp > NOW() - INTERVAL '7' DAY GROUP BY step, detail ORDER BY n DESC",
).catch(() => []);
const funnelNote = oauthFunnelNote(challenges, funnelRows);
const connectCallersText = connectCallersNote(connectCallers);
// After the wall (gankdat preview-wall-next-steps, 2026-10-11): the wall and the three ways on
// now carry the preview's hashed client id in blob6 (routes/mcp.ts, mcp/server.ts, x402/routes.ts),
// so the row says what a wall-hitter did in the following hour — the free-key request, an x402
// payment, the connect_account sign-in attempt — or that it left. Points written before 10-11
// have no blob6 and are left out.
const wallRows = await ae(
  "SELECT blob6 AS client, timestamp AS ts FROM gankdat_traffic WHERE blob1 = 'mcp_denied' AND blob4 = 'preview_exhausted' AND blob6 != '' AND timestamp > NOW() - INTERVAL '7' DAY LIMIT 5000",
).catch(() => []);
const moveRows = await ae(
  "SELECT blob6 AS client, timestamp AS ts, blob1 AS kind FROM gankdat_traffic WHERE blob6 != '' AND timestamp > NOW() - INTERVAL '7' DAY AND ((blob1 = 'mcp_anon' AND blob5 LIKE '%request_api_key%') OR (blob1 = 'x402_paid' AND blob2 NOT LIKE 'gankdat-x402-probe/%') OR (blob1 = 'mcp_denied' AND blob4 = 'protected_tool')) LIMIT 5000",
).catch(() => []);
const afterWallText = afterWallNote(
  wallRows,
  moveRows.map((r) => ({
    client: r.client,
    ts: r.ts,
    kind: r.kind === 'x402_paid' ? 'x402' : r.kind === 'mcp_denied' ? 'connect' : 'request_api_key',
  })),
);

// The live MCP probe (scripts/mcp-probe.ts) makes three authed and three keyless calls a day
// under its own user agent (blob2); the counts below are real traffic, so it is skipped
// (gankdat `probe-key-from-runner`, 2026-10-09 — before the one-run key the authed count read
// clean only because no authed probe ran).
const kinds = Object.fromEntries(
  (
    await ae(
      "SELECT blob1 AS kind, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE timestamp > NOW() - INTERVAL '1' DAY AND blob2 NOT LIKE 'gankdat-mcp-probe/%' AND blob2 NOT LIKE 'gankdat-x402-probe/%' GROUP BY kind",
    )
  ).map((r) => [r.kind, Math.round(Number(r.n))]),
);
const paywall = n(
  await ae(
    "SELECT SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'mcp_denied' AND blob3 LIKE '%tools/call%' AND timestamp > NOW() - INTERVAL '1' DAY",
  ),
  'n',
);

const wanted = await ae(
  "SELECT blob5 AS tool, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'mcp_denied' AND blob5 != '' AND timestamp > NOW() - INTERVAL '1' DAY GROUP BY tool ORDER BY n DESC LIMIT 3",
);
const wantedNote = wanted.length
  ? `; wanted: ${wanted.map((r) => `${r.tool} ${Math.round(Number(r.n))}`).join(', ')}`
  : '';

// STRATEGY §4 targets "change-feed calls / week: 50" and change-feed-upsell /
// trademark-watch-surface are both proved by that number, but nothing counted it:
// review 2026-W39 §1 had to write "unknown, likely 0". Both surfaces in one query,
// over 7 days to match the weekly target — MCP get_changes tool calls (blob5 carries
// the tool names) plus the REST /v1/changes data point added in the same commit.
const changeFeed = Object.fromEntries(
  (
    await ae(
      "SELECT blob1 AS kind, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob2 NOT LIKE 'gankdat-mcp-probe/%' AND blob2 NOT LIKE 'gankdat-x402-probe/%' AND ((blob1 = 'mcp_authed' AND blob5 LIKE '%get_changes%') OR blob1 = 'rest_changes') GROUP BY kind",
    )
  ).map((r) => [r.kind, Math.round(Number(r.n))]),
);
const changesMcp = changeFeed.mcp_authed ?? 0;
const changesRest = changeFeed.rest_changes ?? 0;
// Who made them (2026-10-25, `x402-buyer-vs-survey-split`): the 10-21 reading was the first
// non-zero after 20 rows at 0 and named nobody, so the same filter grouped by user agent renders
// `changes 7d by UA: python-requests 4 (rest)` — a scanner's sweep tagged `prober` by its name.
const changesByUa = await ae(
  "SELECT blob1 AS kind, blob2 AS ua, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob2 NOT LIKE 'gankdat-mcp-probe/%' AND blob2 NOT LIKE 'gankdat-x402-probe/%' AND ((blob1 = 'mcp_authed' AND blob5 LIKE '%get_changes%') OR blob1 = 'rest_changes') GROUP BY kind, ua LIMIT 500",
).catch(() => null);

// Keyless Atom feeds (build 2026-10-05, queue `change-feed-rss`): proof is ≥ 20 distinct feed-reader /
// automation user agents on /feeds in 30 days and a key issued with a /feeds referrer, so the row
// carries the 30-day fetch count and distinct UAs (blob2) plus the cache miss share (blob4).
// 2026-10-07 (`feeds-reading-reason`): the miss share is a sumIf — the first row after the feeds
// shipped read `n/a` because the SUM of a value times a comparison was rejected and the reason was
// swallowed; a failed reading now carries it like the `cf usage` readings do.
const feedsNote = await ae(
  "SELECT COUNT(DISTINCT blob2) AS uas, SUM(_sample_interval * double1) AS n, sumIf(_sample_interval * double1, blob4 = 'miss') AS misses FROM gankdat_traffic WHERE blob1 = 'rest_feed' AND timestamp > NOW() - INTERVAL '30' DAY",
)
  .then(
    (feeds) =>
      `feeds 30d: ${Math.round(Number(feeds[0]?.n ?? 0))} fetches, ${Math.round(Number(feeds[0]?.uas ?? 0))} user agents, ${Math.round(Number(feeds[0]?.misses ?? 0))} renders`,
  )
  .catch((e) => `feeds 30d: n/a (${String(e instanceof Error ? e.message : e).slice(0, 120)})`);

// IndexNow (build 2026-10-05; moved to the runner 2026-10-07, queue `indexnow-from-runner`): the
// metrics workflow's runner-refresh step submits the day's refreshed /stats pages from the runner's
// own IP — api.indexnow.org answered 429 to every POST from Workers egress — and leaves the result
// in dist/indexnow.json; a push run (no runner step) or a dead step reads `n/a (<reason>)`.
const indexnowNote = await readFile(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'indexnow.json'),
  'utf8',
)
  .then((text) => {
    const r = JSON.parse(text);
    return r.date === new Date().toISOString().slice(0, 10)
      ? `indexnow: ${r.urls} urls ${r.status ?? 'n/a'}`
      : `indexnow: n/a (runner result dated ${r.date})`;
  })
  .catch((e) => `indexnow: n/a (${e.code === 'ENOENT' ? 'no runner result' : e.message})`);

// Live MCP probe (gankdat `mcp-live-probe`, 2026-10-08): scripts/mcp-probe.ts runs before this
// script in the metrics job (push runs too — builtins only) and leaves in dist/mcp-probe.json the
// HTTP status of `initialize`, `tools/list` and one preview `tools/call` against the live /mcp,
// keyless and, with GANKDAT_PROBE_KEY, with a bearer key — what Glama's hourly health check sees
// (it mailed "HTTP 500 – Error connecting to MCP" on 2026-10-08 and no sandbox could look). A
// failed step is also listed under `refresh errors` as `mcp-probe`, so the two-rows-in-four rule
// queues a fix; a probe dated another day or missing reads `n/a (<reason>)` and lists nothing.
const { probeNote, probeError } = await import('../../../scripts/mcp-probe.ts');
const probeResult = await readFile(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mcp-probe.json'),
  'utf8',
)
  .then((text) => {
    const r = JSON.parse(text);
    return r.date === new Date().toISOString().slice(0, 10) ? r : null;
  })
  .catch(() => null);
const mcpProbeNote = probeResult ? probeNote(probeResult) : 'mcp probe: n/a (no probe result)';
const mcpProbeError = probeResult ? probeError(probeResult) : null;

// Wave log reading (gankdat `wave-log-reading`, 2026-10-09): the runner-refresh step asks Workers
// observability for the last 24 h of log lines of every source with no `ok` row in 26 h or an
// error row today and leaves them in dist/wave-logs.json; the row names each one's newest line
// and age, so a wave killed at the Cron Trigger limit (no refresh_log row at all) is read, not
// guessed. A push run (no runner step) or a result dated another day reads `n/a (<reason>)`.
const { waveLogNote } = await import('../src/lib/wave-logs.ts');
const waveLogFile = await readFile(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'wave-logs.json'),
  'utf8',
)
  .then((text) => {
    const r = JSON.parse(text);
    return r.date === new Date().toISOString().slice(0, 10) ? r : null;
  })
  .catch(() => null);
const waveLogText = waveLogNote(waveLogFile, Date.now());
if (mcpProbeError) {
  errors.push({ source_slug: mcpProbeError.slug, message: mcpProbeError.message });
  errors.sort((a, b) => a.source_slug.localeCompare(b.source_slug));
}

// STRATEGY §4 target "Apify paid runs / month: 100" was unmeasured — review 2026-W39 §4 had to
// write "no run count reaches the repo" — yet all 17 actors are public since 2026-09-28, so the
// shelf either produces runs or it does not. Field names confirmed against a live
// GET /v2/acts/apify~web-scraper through the relay (docs/relay), not from memory:
// stats.totalRuns, stats.totalUsers30Days, isPublic. The `?my=1` list itself was then read in CI
// (run 36753533977): its entries carry `stats` but NOT `isPublic`, so every actor falls through to
// its own endpoint for the public count — as publish-actors.mjs already does for pricingInfos.
// Do not drop that fallback because the list looks complete: without it `P public` reads 0. Each
// run logs the keys it saw, so a shape change shows up in the log before it shows up in the row.
// APIFY_TOKEN is optional: without it, or if the API is down, the row still lands as `apify: n/a`
// rather than losing the D1 and Analytics Engine numbers with it.
//
// Who ran what (metrics-apify-paid-runs, burn-down 2026-10-04): review W40 read `17 users/30d` as
// one user per actor — us or Apify's QA runner, not buyers — and a lifetime total cannot say who ran
// an actor this month. The actor endpoint also carries `stats.publicActorRunStats30Days.TOTAL`,
// every account's runs of that actor in the last 30 days (relay `apify-actor-stats`, 2026-10-04:
// web-scraper 301230, uk-no-website-leads 6), while `GET /v2/actor-runs` lists only the token
// owner's runs. So the row prints `30d: T runs (O ours, X others)` with X = T − O. Apify's QA
// runner is one of the "others" and the API cannot tell it from a buyer, so X is the ceiling of
// paid runs, never a sales figure: the paid reading of record is Apify's monthly payout mail
// (inbox triage logs it). The own-runs list is read newest first and stops at the first run
// older than 30 days; if that call fails or has no `startedAt`, ours reads `n/a` and the rest of
// the row survives.
//
// Which actors (apify-runs-per-actor, burn-down 2026-10-05): one total cannot say which registers
// Apify users run, so the exchange item `apify-quality-score-pass` ("≥ 10 actors with 0 runs")
// and STRATEGY §7's per-dataset rule had no Apify reading. Each actor's 30-day total minus our
// own runs of it (`actId` on /v2/actor-runs) is printed per actor as `apify 30d by actor:
// <name> N, …; 0: a, b` — N = runs by other accounts (Apify's QA runner included), most first,
// zero-run actors named after `0:` in the `datasets 30d:` shape. Without the own-runs list the
// per-actor figures are all accounts' and the line says so.
//
// Outcomes (apify-run-outcomes-reading, burn-down 2026-10-11): `publicActorRunStats30Days` is by
// status, so each actor gets a `(F failed)` suffix (failed + timed-out, every account) and an actor
// whose F rose since the previous row is listed under `refresh errors` as `apify-<name>` — the
// auto-filer then files `refresh-apify-<name>` a day before Apify's "under maintenance" mail.
// Rules and parsing in src/lib/apify-outcomes.ts.
const { byActorNote, failedCount, newlyFailing, previousFailed } =
  await import('../src/lib/apify-outcomes.ts');
const apifyToken = process.env.APIFY_TOKEN;
const DAY_MS = 86_400_000;
/** Our own runs in the last 30 days: the total and a count per actor id. */
async function apifyOwnRuns30d(H) {
  const since = Date.now() - 30 * DAY_MS;
  let count = 0;
  const byActor = new Map();
  let offset = 0;
  for (;;) {
    const res = await fetch(
      `https://api.apify.com/v2/actor-runs?desc=1&limit=1000&offset=${offset}`,
      {
        headers: H,
      },
    );
    if (!res.ok) throw new Error(`GET /v2/actor-runs: HTTP ${res.status}`);
    const items = (await res.json()).data?.items ?? [];
    if (items.length && !items[0].startedAt) {
      throw new Error(
        `GET /v2/actor-runs: no startedAt (keys: ${Object.keys(items[0]).join(',')})`,
      );
    }
    const recent = items.filter((r) => Date.parse(r.startedAt) >= since);
    count += recent.length;
    for (const r of recent) byActor.set(r.actId, (byActor.get(r.actId) ?? 0) + 1);
    if (recent.length < items.length || items.length < 1000) return { count, byActor };
    offset += items.length;
  }
}
async function apifyShelf() {
  if (!apifyToken) return null;
  const H = { Authorization: `Bearer ${apifyToken}` };
  const res = await fetch('https://api.apify.com/v2/acts?my=1&limit=100', { headers: H });
  if (!res.ok) throw new Error(`GET /v2/acts: HTTP ${res.status}`);
  const items = (await res.json()).data?.items ?? [];
  let runs = 0;
  let runs30 = 0;
  let users = 0;
  let publicCount = 0;
  let fromDetail = 0;
  const perActor = [];
  for (const item of items) {
    let act = item;
    if (!item.stats || item.isPublic === undefined || !item.stats.publicActorRunStats30Days) {
      const one = await fetch(`https://api.apify.com/v2/acts/${item.id}`, { headers: H });
      if (!one.ok) throw new Error(`GET /v2/acts/${item.id}: HTTP ${one.status}`);
      act = { ...item, ...((await one.json()).data ?? {}) };
      fromDetail += 1;
    }
    runs += Math.round(Number(act.stats?.totalRuns ?? 0));
    const actRuns30 = Math.round(Number(act.stats?.publicActorRunStats30Days?.TOTAL ?? 0));
    runs30 += actRuns30;
    perActor.push({
      id: act.id,
      name: act.name,
      runs30: actRuns30,
      failed: failedCount(act.stats?.publicActorRunStats30Days),
    });
    users += Math.round(Number(act.stats?.totalUsers30Days ?? 0));
    if (act.isPublic) publicCount += 1;
  }
  console.log(
    `apify: ${items.length} actors, ${fromDetail} read from their own endpoint for isPublic (list keys: ${Object.keys(items[0] ?? {}).join(',')})`,
  );
  const own = await apifyOwnRuns30d(H).catch((e) => {
    console.error(`apify own runs: ${e.message}`);
    return null;
  });
  const ours30 = own ? own.count : null;
  // Per actor: runs by other accounts (total minus ours), most first; zero-run actors named.
  const outcomes = perActor.map((a) => ({
    name: a.name,
    n: Math.max(0, a.runs30 - (own?.byActor.get(a.id) ?? 0)),
    total: a.runs30,
    failed: a.failed,
  }));
  const byActor = byActorNote(outcomes, Boolean(own));
  return { runs, runs30, ours30, users, publicCount, byActor, outcomes };
}
const apify = await apifyShelf().catch((e) => {
  console.error(`apify: ${e.message}`);
  return null;
});

// Cloudflare metered usage, billing period to date (cloudflare-usage-breakdown, build 2026-10-04).
// The invoice runs 10th → 10th (the 2026-10-01 budget alert covered 2026-09-10..10-10 and said
// US$15 against the US$5 Workers Paid line with GBP 0 revenue — STRATEGY §7's cost rule), and
// nothing in the repo knew which product carried it. GraphQL Analytics (needs "Account
// Analytics: Read" on the token) gives rows written/read per D1 database, KV operations by
// kind, Worker requests and D1 storage; data points come from the Analytics Engine SQL API the
// row already uses. Each reading is its own query, so one missing permission or renamed field
// degrades to `n/a (<reason>)` in the row — the next routine can fix that query — and never
// loses the other numbers. Prices are the Workers Paid plan's published rates (USD, 2026-10):
// the "≈ US$" figure is the overage above the included allowances, to be read against the
// invoice, not instead of it.
const CF_PRICES = {
  d1Writes: { included: 50e6, perMillion: 1.0 },
  d1Reads: { included: 25e9, perMillion: 0.001 },
  d1StorageGb: { included: 5, perUnit: 0.75 },
  kvReads: { included: 10e6, perMillion: 0.5 },
  kvWrites: { included: 1e6, perMillion: 5.0 },
  workersRequests: { included: 10e6, perMillion: 0.3 },
  aePoints: { included: 10e6, perMillion: 0.25 },
};
const fmtM = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : `${(v / 1e6).toFixed(1)}M`);
const overage = (value, { included, perMillion }) =>
  Math.max(0, value - included) * (perMillion / 1e6);
async function cfUsage() {
  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (now.getUTCDate() < 10 ? 1 : 0), 10),
  );
  const from = periodStart.toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const days = Math.max(1, Math.ceil((now - periodStart) / 86_400_000));
  const gql = async (selection) => {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ viewer { accounts(filter: { accountTag: "${ACCOUNT_ID}" }) { ${selection} } } }`,
      }),
    });
    const body = await res.json();
    if (body.errors?.length) {
      throw new Error(
        body.errors
          .map((e) => e.message)
          .join('; ')
          .slice(0, 100),
      );
    }
    const account = body.data?.viewer?.accounts?.[0];
    if (!account) throw new Error(`HTTP ${res.status}, no account in response`);
    return account;
  };
  const sumOf = (rows, key) => rows.reduce((acc, r) => acc + Number(r.sum?.[key] ?? 0), 0);
  const reading = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error(`cf usage ${label}: ${e.message}`);
      return { error: `${label}: ${e.message}` };
    }
  };
  const d1 = await reading('d1', async () => {
    const { d1AnalyticsAdaptiveGroups: rows } = await gql(
      `d1AnalyticsAdaptiveGroups(limit: 1000, filter: { date_geq: "${from}", date_leq: "${to}" }) { dimensions { databaseId } sum { rowsRead rowsWritten readQueries writeQueries } }`,
    );
    return { writes: sumOf(rows, 'rowsWritten'), reads: sumOf(rows, 'rowsRead') };
  });
  const storage = await reading('d1 storage', async () => {
    const { d1StorageAdaptiveGroups: rows } = await gql(
      `d1StorageAdaptiveGroups(limit: 1000, filter: { date_geq: "${from}", date_leq: "${to}" }, orderBy: [date_DESC]) { dimensions { date databaseId } max { databaseSizeBytes } }`,
    );
    const latest = rows[0]?.dimensions?.date;
    const bytes = rows
      .filter((r) => r.dimensions?.date === latest)
      .reduce((acc, r) => acc + Number(r.max?.databaseSizeBytes ?? 0), 0);
    return { gb: bytes / 1e9 };
  });
  const kv = await reading('kv', async () => {
    const { kvOperationsAdaptiveGroups: rows } = await gql(
      `kvOperationsAdaptiveGroups(limit: 1000, filter: { date_geq: "${from}", date_leq: "${to}" }) { dimensions { actionType } sum { requests } }`,
    );
    const reads = sumOf(
      rows.filter((r) => r.dimensions?.actionType === 'read'),
      'requests',
    );
    return { reads, writes: sumOf(rows, 'requests') - reads };
  });
  const workers = await reading('workers', async () => {
    const { workersInvocationsAdaptive: rows } = await gql(
      `workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: "${periodStart.toISOString()}", datetime_leq: "${now.toISOString()}" }) { sum { requests } }`,
    );
    return { requests: sumOf(rows, 'requests') };
  });
  const aePoints = await reading('ae', async () => {
    const rows = await ae(
      `SELECT SUM(_sample_interval) AS points FROM gankdat_traffic WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    );
    return { points: Math.round(Number(rows[0]?.points ?? 0)) };
  });
  const parts = [];
  const costs = [];
  if (!d1.error) {
    parts.push(`d1 ${fmtM(d1.writes)} writes / ${fmtM(d1.reads)} reads`);
    costs.push(['d1 writes', overage(d1.writes, CF_PRICES.d1Writes)]);
    costs.push(['d1 reads', overage(d1.reads, CF_PRICES.d1Reads)]);
  }
  if (!storage.error) {
    parts.push(`${storage.gb.toFixed(1)} GB`);
    costs.push([
      'd1 storage',
      Math.max(0, storage.gb - CF_PRICES.d1StorageGb.included) * CF_PRICES.d1StorageGb.perUnit,
    ]);
  }
  if (!kv.error) {
    parts.push(`kv ${fmtM(kv.reads)} reads / ${fmtM(kv.writes)} writes`);
    costs.push(['kv reads', overage(kv.reads, CF_PRICES.kvReads)]);
    costs.push(['kv writes', overage(kv.writes, CF_PRICES.kvWrites)]);
  }
  if (!workers.error) {
    parts.push(`workers ${fmtM(workers.requests)} req`);
    costs.push(['workers', overage(workers.requests, CF_PRICES.workersRequests)]);
  }
  if (!aePoints.error) {
    parts.push(`ae ${fmtM(aePoints.points)} pts`);
    costs.push(['ae', overage(aePoints.points, CF_PRICES.aePoints)]);
  }
  const errors = [d1, storage, kv, workers, aePoints].filter((r) => r.error).map((r) => r.error);
  if (parts.length === 0) return `cf usage: n/a (${errors.join('; ').slice(0, 160)})`;
  const total = costs.reduce((acc, [, v]) => acc + v, 0);
  const drivers = costs
    .filter(([, v]) => v >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} US$${v.toFixed(0)}`)
    .join(', ');
  return `cf usage (${from.slice(5)}→${to.slice(5)}): ${parts.join(', ')} ≈ US$${total.toFixed(0)} overage${drivers ? ` (${drivers})` : ''}${errors.length ? `; n/a: ${errors.join('; ').slice(0, 120)}` : ''}`;
}
const cfNote = await cfUsage().catch((e) => `cf usage: n/a (${e.message.slice(0, 100)})`);

// AI-crawler hits on the stats pages (new-ventures `spike-pay-per-crawl-stats-pages`, 2026-10-17):
// Cloudflare's Pay Per Crawl charges AI crawlers per successful fetch of a zone's pages, and the
// spike's one unknown was how many fetches of `/stats/<slug>` those crawlers already make. Three
// readings (src/lib/crawler-hits.ts), each degrading to `n/a (<reason>)` on its own: the Worker's
// request lines in Workers Logs (7 days, user agent read from the line itself), the zone's HTTP
// analytics by user agent (httpRequestsAdaptiveGroups keeps ≥ 31 days on every plan, relay
// pay-per-crawl-2026-10-17; the zone tag comes from the zones list, so a token without Zone Read
// says so) and the `/mcp` Analytics Engine rows as the 30-day proxy. The folded counts are also
// printed, so a routine reading the job log sees the user agents behind the families.
async function statsCrawlers() {
  const nowMs = Date.now();
  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (e) {
      console.error(`stats crawlers ${label}: ${e.message}`);
      return { error: `${label}: ${e.message.slice(0, 80)}` };
    }
  };
  const statsLogs = await attempt('logs', async () => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/observability/telemetry/query`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(statsPageLogQuery(nowMs)),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}${res.status === 403 ? ' (token lacks Workers Observability Read)' : ` ${text.replace(/\s+/g, ' ').slice(0, 160)}`}`,
      );
    }
    const folded = foldStatsLogEvents(JSON.parse(text));
    console.log(`stats crawlers logs: ${JSON.stringify(folded)}`);
    if (folded.lines === 0) console.log(`stats crawlers logs body: ${text.slice(0, 400)}`);
    return { ...folded, hours: STATS_LOG_HOURS, limit: STATS_LOG_LIMIT };
  });
  const zone = await attempt('zone', async () => {
    const zres = await fetch('https://api.cloudflare.com/client/v4/zones?name=gankdat.com', {
      headers,
    });
    const zbody = await zres.json();
    const zoneTag = zbody.result?.[0]?.id;
    if (!zoneTag) {
      throw new Error(
        `zones: HTTP ${zres.status} ${JSON.stringify(zbody.errors ?? []).slice(0, 80)}`,
      );
    }
    const query = async (days) => {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          query: zoneStatsQuery(
            zoneTag,
            new Date(nowMs - days * 86_400_000).toISOString(),
            new Date(nowMs).toISOString(),
          ),
        }),
      });
      const body = await res.json();
      if (body.errors?.length) {
        throw new Error(
          body.errors
            .map((e) => e.message)
            .join('; ')
            .slice(0, 100),
        );
      }
      return zoneStatsRows(body);
    };
    let days = 30;
    let rows;
    try {
      rows = await query(days);
    } catch (e) {
      console.error(`stats crawlers zone 30d: ${e.message}; trying 7d`);
      days = 7;
      rows = await query(days);
    }
    console.log(`stats crawlers zone ${days}d: ${JSON.stringify(rows.slice(0, 40))}`);
    return { ...foldFamilies(rows), days };
  });
  const mcp = await attempt('mcp', async () => {
    const rows = await ae(mcpCrawlerSql(30));
    const folded = foldFamilies(
      rows.map((r) => ({ userAgent: String(r.ua ?? ''), hits: Number(r.n ?? 0) })),
    );
    console.log(`stats crawlers /mcp 30d: ${JSON.stringify(folded)}`);
    return { ...folded, days: 30 };
  });
  return crawlerNote({ statsLogs, zone, mcp });
}
const crawlersNote = await statsCrawlers().catch(
  (e) => `stats crawlers: n/a (${e.message.slice(0, 100)})`,
);

// Per-dataset authed queries over 30 days (build 2026-10-04, queue `metrics-dataset-queries-30d`):
// STRATEGY §7 retires a dataset nobody queried for 60 days, and until now nothing in the repo said
// how many authed REST or MCP calls each dataset received. REST: `rest_data` points carry the slug
// in blob5; MCP: `mcp_authed` points carry the comma-joined tool names in blob5, and a data tool is
// `query_<slug with _>`. Zero-call datasets are listed by name so the review sees them. The slug
// list comes from the source files on disk (each declares `slug: '…'`), not from the API.
//
// External (gankdat `metrics-dataset-queries-external`, 2026-10-11): the count above was our own
// automation — the Apify actors run on the repo's key, the probe calls every tool daily — so every
// register sat at 85–100 calls with the floor rising in lockstep, and §7's 60-day clock read a
// polluted number. Authed points now carry the key's account id (`rest_data` blob4, `mcp_authed`
// blob6, both since 10-11); the second line leaves out every account with an internal mailbox
// (the Apify key's, the probe's, the owner's — INTERNAL_EMAIL_SQL below) and the points from before
// the tag, which have no account and cannot be told apart. The first line stays for continuity.
const INTERNAL_EMAIL_SQL =
  "email LIKE '%@gankdat.com' OR email LIKE '%@1402celsius.com' OR email LIKE '%@example.com' OR email LIKE 'giova1506@%'";
async function sourceSlugs() {
  const { readdir } = await import('node:fs/promises');
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'sources');
  const slugs = new Set();
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.ts')) continue;
    const m = (await readFile(path.join(dir, f), 'utf8')).match(/^\s+slug: '([a-z0-9-]+)',$/m);
    if (m) slugs.add(m[1]);
  }
  return slugs;
}
/**
 * `{ label, restWhere, mcpWhere, extra }` → `datasets 30d<label>: <slug> N, …; 0: a, b`. `extra` is
 * paid x402 calls per slug (2026-10-19, `x402-paid-by-source-reading`): a settled payment on a
 * register is external demand §7's clock must see, so it counts in the total and the slug reads
 * `uk-sanctions 3 (x402 3)`.
 */
async function datasetQueries30d(label = '', restWhere = '', mcpWhere = '', extra = null) {
  const slugs = await sourceSlugs();
  const counts = new Map([...slugs].map((s) => [s, 0]));
  const add = (slug, n) => {
    if (slug && slugs.has(slug)) counts.set(slug, (counts.get(slug) ?? 0) + Number(n));
  };
  const rest = await ae(
    `SELECT blob5 AS slug, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'rest_data' AND blob5 != ''${restWhere} AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY slug`,
  );
  for (const r of rest) add(r.slug, r.n);
  const mcp = await ae(
    `SELECT blob5 AS tools, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'mcp_authed' AND blob5 != '' AND blob2 NOT LIKE 'gankdat-mcp-probe/%' AND blob2 NOT LIKE 'gankdat-x402-probe/%'${mcpWhere} AND timestamp > NOW() - INTERVAL '30' DAY GROUP BY tools`,
  );
  for (const r of mcp) {
    for (const tool of String(r.tools).split(',')) {
      if (tool.startsWith('query_')) add(tool.slice('query_'.length).replaceAll('_', '-'), r.n);
    }
  }
  const paid = new Map();
  for (const [slug, n] of extra ?? []) {
    if (slugs.has(slug) && n > 0) {
      add(slug, n);
      paid.set(slug, n);
    }
  }
  const used = [...counts]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} ${Math.round(n)}${paid.has(s) ? ` (x402 ${paid.get(s)})` : ''}`);
  const zero = [...counts]
    .filter(([, n]) => n === 0)
    .map(([s]) => s)
    .sort();
  return `datasets 30d${label}: ${used.length ? used.join(', ') : 'none'}${zero.length ? `; 0: ${zero.join(', ')}` : ''}`;
}
const x402Base = (process.env.PUBLIC_BASE_URL || 'https://gankdat.com').replace(/\/+$/, '');
// The live source list, shared by the sales clauses here and the validate and Bazaar clauses
// below (one read; a failure makes each clause `n/a` with the same reason).
const x402Slugs = (async () => {
  const listing = await fetch(`${x402Base}/v1/data`, { signal: AbortSignal.timeout(15_000) });
  if (!listing.ok) throw new Error(`/v1/data ${listing.status}`);
  return (await listing.json()).data.map((s) => s.slug);
})();
x402Slugs.catch(() => {}); // each clause reports the rejection itself
// The route count is the buyer-vs-prober split's sweep threshold (one client paying every route
// once in a day is the Bazaar indexer, not a customer); unread, only the UA rule applies.
const x402RouteCount = await x402Slugs.then((slugs) => slugs.length).catch(() => null);
// What sold on the x402 lane (2026-10-19, `x402-paid-by-source-reading`): the `x402_paid` point
// carries the UA (blob2), the slug (blob5) and the hashed client id (blob6), so the row names the
// source, the distinct clients and the UA family behind its count — the lane's first three
// external payments (10-17/18) reached the row as a bare `3 x402 paid`. Grouped reads for 24 h
// and 30 d, the probe's user agent excluded; a failed read leaves the bare count in place. The
// 30-day read is grouped by UTC day as well (2026-10-25, `x402-buyer-vs-survey-split`) so the
// split can see a one-day catalogue sweep and a buyer who paid on two or more days (repeat).
const x402PaidRows = (days, byDay = false) =>
  ae(
    `SELECT blob5 AS slug, blob2 AS ua, blob6 AS client${byDay ? ", toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day" : ''}, SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'x402_paid' AND blob2 NOT LIKE 'gankdat-x402-probe/%' AND timestamp > NOW() - INTERVAL '${days}' DAY GROUP BY slug, ua, client${byDay ? ', day' : ''} LIMIT 5000`,
  ).catch(() => null);
const x402Rows24 = await x402PaidRows(1);
const x402Rows30 = await x402PaidRows(30, true);
const x402Note30d = x402Paid30dNote(x402Rows30, x402RouteCount);
const datasetsNote = await datasetQueries30d().catch(
  (e) => `datasets 30d: n/a (${e.message.slice(0, 100)})`,
);
const internalAccountIds = await sql(`SELECT id FROM accounts WHERE ${INTERNAL_EMAIL_SQL}`)
  .then((rows) => rows.map((r) => String(r.id)).filter((id) => /^[\w-]+$/.test(id)))
  .catch(() => null);
const notIn = (blob) =>
  ` AND ${blob} != ''${internalAccountIds.length ? ` AND ${blob} NOT IN (${internalAccountIds.map((id) => `'${id}'`).join(', ')})` : ''}`;
const datasetsExternalNote = internalAccountIds
  ? await datasetQueries30d(
      ' external',
      notIn('blob4'),
      notIn('blob6'),
      x402CallsBySlug(x402Rows30, x402RouteCount),
    ).catch((e) => `datasets 30d external: n/a (${e.message.slice(0, 100)})`)
  : 'datasets 30d external: n/a (internal accounts unreadable from D1)';

const date = new Date().toISOString().slice(0, 10);
const users = `${acct.total} accts (${acct.paid ?? 0} paid, +${acct.new24h ?? 0}/24h)`;
// The owner's indexing payment and any runner probe pay under `gankdat-x402-probe/…`
// (scripts/x402-test-client.mjs): excluded from the sale count above, shown beside it.
const ownX402 = await ae(
  "SELECT SUM(_sample_interval * double1) AS n FROM gankdat_traffic WHERE blob1 = 'x402_paid' AND blob2 LIKE 'gankdat-x402-probe/%' AND timestamp > NOW() - INTERVAL '1' DAY",
)
  .then((rows) => Math.round(Number(rows[0]?.n ?? 0)))
  .catch(() => 0);
const sales = `${x402PaidClause(kinds.x402_paid ?? 0, x402Rows24, x402RouteCount)}${ownX402 ? ` (+${ownX402} own probe)` : ''}`;

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'RESEARCH.md');
let md = await readFile(file, 'utf8');
// The Apify API gives lifetime run totals, so the 24 h delta has to come from the row before
// this one — the only place a previous total is kept. Today's row is skipped: a re-run rewrites
// it, and it must not become its own baseline. Only the immediately preceding row counts, so the
// first row after this ships reads `baseline` rather than inventing a delta against nothing.
const prevRuns = (() => {
  const rows = (md.match(/^\| \d{4}-\d{2}-\d{2} \| Daily numbers \|.*$/gm) ?? []).reverse();
  for (const r of rows) {
    if (r.startsWith(`| ${date} `)) continue;
    const m = r.match(/apify: (\d+) runs/);
    return m ? Number(m[1]) : null;
  }
  return null;
})();
// Actors whose 30-day failed count rose since the previous row → refresh errors (see the Apify
// block above); no previous reading → nothing flagged, never a failed job.
for (const e of apify ? newlyFailing(apify.outcomes, previousFailed(md, date)) : []) {
  errors.push({ source_slug: e.source_slug, message: e.message });
}

/** The first failed check in a validate response, whatever shape `preflight` takes; else the outcome. */
function firstPreflightFailure(body) {
  const found = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.passed === false || /^(fail|failed|error)$/i.test(String(v.status ?? v.result ?? ''))) {
      found.push(
        String(v.message ?? v.name ?? v.check ?? v.code ?? JSON.stringify(v)).slice(0, 80),
      );
    }
    Object.values(v).forEach(walk);
  };
  walk(body.preflight ?? body);
  return found[0] ?? String(body.simulation?.outcome ?? body.error ?? 'invalid').slice(0, 80);
}

// x402 Bazaar dry run (gankdat `x402-bazaar-listing`, 2026-10-14): CDP's keyless validate
// endpoint checks a resource the way the Bazaar's indexer does — reachable, answers 402,
// advertises a valid extensions.bazaar block — and is reachable from the runner (the sandbox
// proxy refuses api.cdp.coinbase.com, so no build can run it). One POST per live source, four
// at a time; the row reads `x402 validate: 17/17 valid`, or names the failing slugs with the
// first preflight failure each, or `n/a (<reason>)` when the listing or the endpoint cannot be
// read. Validation does not cover the metadata content policy: the indexed count comes from
// the discovery API (`metrics-bazaar-merchant-read`), never from this line.
const x402ValidateNote = await (async () => {
  const base = x402Base;
  const slugs = await x402Slugs;
  const results = [];
  for (let i = 0; i < slugs.length; i += 4) {
    results.push(
      ...(await Promise.all(
        slugs.slice(i, i + 4).map(async (slug) => {
          try {
            const res = await fetch('https://api.cdp.coinbase.com/platform/v2/x402/validate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ resource: `${base}/x402/data/${slug}`, method: 'GET' }),
              signal: AbortSignal.timeout(20_000),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) return { slug, reason: `HTTP ${res.status}` };
            return body.valid === true ? { slug } : { slug, reason: firstPreflightFailure(body) };
          } catch (e) {
            return { slug, reason: String(e instanceof Error ? e.message : e).slice(0, 60) };
          }
        }),
      )),
    );
  }
  const failing = results.filter((r) => r.reason);
  const head = `x402 validate: ${results.length - failing.length}/${results.length} valid`;
  return failing.length
    ? `${head} (${failing
        .map((r) => `${r.slug}: ${r.reason}`)
        .join(', ')
        .slice(0, 300)})`
    : head;
})().catch(
  (e) => `x402 validate: n/a (${String(e instanceof Error ? e.message : e).slice(0, 100)})`,
);

// x402 Bazaar reading (gankdat `metrics-bazaar-merchant-read`, 2026-10-14): the proof of the
// listing is the catalogue's own count, never our x402_paid points (which include the owner's
// indexing call). The receiving wallet is a Worker secret, so the runner reads it from the 402 of
// the first live route (`PAYMENT-REQUIRED`, keyless, no payment), then asks CDP's keyless merchant
// discovery endpoint for every active resource under that payTo and sums the quality numbers the
// Bazaar ranks by (both reads in scripts/x402-catalogue.mjs, shared with the probe since
// 2026-10-23: CDP lists one resource per settled payment, so the probe pays each unlisted route).
// `n/a (<reason>)` when either read fails. Pure parsing lives in scripts/x402-bazaar-read.ts.
const bazaarNote = await (async () => {
  const slugs = await x402Slugs;
  if (!slugs.length) throw new Error('no live sources');
  const payTo = await readPayTo(x402Base, slugs[0], 'gankdat-metrics/1 (+https://gankdat.com)');
  const resources = await readMerchantCatalogue(payTo);
  for (const line of bazaarResourceLines(resources, x402Base)) console.log(line);
  return bazaarClause(bazaarSummary(resources, x402Base));
})().catch((e) => `bazaar: n/a (${String(e instanceof Error ? e.message : e).slice(0, 100)})`);

const notes = [
  // preview = keyless data-tool calls (5 rows, 20/day per client, since 2026-09-30 for the
  // Claude Connectors Directory); paywall hits = the plan text shown when that budget is spent
  // or a presented key is bad. Both are blob1 kinds written by routes/mcp.ts + mcp/server.ts.
  `MCP 24h: ${kinds.mcp_authed ?? 0} authed, ${kinds.mcp_anon ?? 0} anon, ${kinds.mcp_preview ?? 0} preview, ${paywall} paywall hits${wantedNote}`,
  `changes 7d: ${changesMcp + changesRest} (mcp ${changesMcp}, rest ${changesRest})`,
  changesByUaNote(changesByUa),
  indexnowNote,
  x402ValidateNote,
  bazaarNote,
  x402Note30d,
  mcpProbeNote,
  waveLogText,
  feedsNote,
  apify
    ? `apify: ${apify.runs} runs (${prevRuns === null ? 'baseline' : `+${apify.runs - prevRuns}/24h`}), 30d: ${apify.runs30} runs (${apify.ours30 === null ? 'ours n/a' : `${apify.ours30} ours, ${apify.runs30 - apify.ours30} others`}), ${apify.users} users/30d, ${apify.publicCount} public`
    : 'apify: n/a',
  apify ? apify.byActor : 'apify 30d by actor: n/a',
  agentKeys
    ? `agent sign-up: ${agentKeys.requests24h ?? 0} req/24h, ${agentKeys.keys24h ?? 0} keys/24h, ${agentKeys.keys30d ?? 0} keys/30d`
    : 'agent sign-up: n/a',
  oauthNote,
  connectCallersText,
  funnelNote,
  afterWallText,
  cfNote,
  crawlersNote,
  datasetsNote,
  datasetsExternalNote,
  ...(silent.length
    ? [
        `silent nights: ${silent
          .map(
            (e) =>
              `${e.source_slug} ${errorText(String(e.message ?? '').replace(/^silent refresh /, ''))}`,
          )
          .join(', ')}`,
      ]
    : []),
  errors.length
    ? `refresh errors: ${errors
        .map((e) => {
          const text = errorText(e.message);
          return text ? `${e.source_slug} (${text})` : e.source_slug;
        })
        .join(', ')}`
    : 'refresh ok',
].join('; ');
const row = `| ${date} | Daily numbers | ${users} | — | ${sales} | ${notes} |`;

if (!/^## Metrics/m.test(md)) {
  md =
    md.trimEnd() +
    '\n\n## Metrics\n\n| Date | Event | Users | Rating | Sales | Notes |\n|---|---|---|---|---|---|\n';
}
if (md.includes(`| ${date} | Daily numbers |`)) {
  if (process.env.METRICS_IF_MISSING) {
    console.log(`row for ${date} already present; METRICS_IF_MISSING set, leaving it`);
    process.exit(0);
  }
  md = md.replace(new RegExp(`^\\| ${date} \\| Daily numbers \\|.*$`, 'm'), row);
} else {
  const i = md.search(/^## Metrics/m);
  const rest = md.slice(i);
  const lastRow = rest.lastIndexOf('\n|');
  const end = i + (lastRow === -1 ? rest.length : rest.indexOf('\n', lastRow + 1));
  md =
    md.slice(0, end === -1 ? undefined : end).trimEnd() +
    '\n' +
    row +
    '\n' +
    (end === -1 ? '' : md.slice(end).replace(/^\n/, '\n'));
}
await writeFile(file, md.endsWith('\n') ? md : md + '\n');
console.log(row);
