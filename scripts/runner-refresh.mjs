#!/usr/bin/env node
// Runner-side refresh for the sources whose origin the Worker cannot read (`RefreshPolicy.runner`).
//
// Why: from 2026-09-28 every Worker read of The Gazette's insolvency feed came back as 0 bytes
// (four paced reads a day, page size halved on 09-30, still nothing) while a GitHub runner read
// the same URL in full each time — the origin cuts the body for the Worker's egress, not for
// anything in the parser. So the `gankdat metrics` job runs this on its runner once a day: the
// source's own `fetchFresh` (same Blind-Mode whitelist, same retries), then the two KV writes the
// Worker would have made (`snapshotWrites` in src/sources/cache.ts) and a `refresh_log` row,
// through the Cloudflare REST API with the deploy token. The Worker's cron waves skip these
// sources (store.ts `cronSources`), so the Daily numbers row keeps reading `refresh_log` as before:
// a day this job fails still lands there as `refresh errors: <slug> (runner: …)`.
//
// Bundled at run time (esbuild) because the sources are TypeScript with Bundler resolution:
//   npm run runner-refresh            (repo root or ventures/gankdat; CLOUDFLARE_API_TOKEN set)
// Idempotent per day: a source whose last `ok` row is under 20 h old is skipped, so the job may
// run on every push to main as the metrics step does. Exit 1 when any source failed.
import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { postIndexNow, statsUrlsFor } from '../src/lib/indexnow.ts';
import {
  WAVE_LOG_QUERY_PATH,
  dropNoise,
  parseWaveInvocations,
  parseWaveLogEvents,
  waveInvocationQuery,
  waveLogQuery,
} from '../src/lib/wave-logs.ts';
import { snapshotWrites, statsKey } from '../src/sources/cache.ts';
import { isOriginUnavailable } from '../src/sources/origin.ts';
import { listSources } from '../src/sources/registry.ts';
import { cronOfSource, isRunnerFed } from '../src/sources/store.ts';

const ACCOUNT_ID = '37e56f3ce4dfe49919e85d4380467f44'; // not a secret
const DATABASE_ID = 'ac051277-5f69-46ba-965b-50da2f1ec524'; // wrangler.jsonc
const CACHE_NAMESPACE_ID = 'eacc87d970e94b9b87ce944985af0b52'; // wrangler.jsonc CACHE binding
// IndexNow (src/lib/indexnow.ts): the one daily submission of the refreshed /stats pages is made
// from this runner (`submitStatsPages` below), never from the Worker. Copied from wrangler.jsonc
// vars (not a secret — it is public at /<key>.txt).
const INDEXNOW_KEY = '25d4108fe9beff29d13ec9422a302e26';
const PUBLIC_BASE_URL = 'https://gankdat.com';
const FRESH_ENOUGH_MS = 20 * 60 * 60 * 1000;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`;

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('CLOUDFLARE_API_TOKEN missing');
  process.exit(1);
}
const auth = { Authorization: `Bearer ${token}` };

/** @param {string} query @param {unknown[]} params */
async function sql(query, params = []) {
  const res = await fetch(`${API}/d1/database/${DATABASE_ID}/query`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ sql: query, params }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.result[0].results;
}

/** @param {{ key: string; value: string; ttl: number }} write */
async function kvPut(write) {
  const url = `${API}/storage/kv/namespaces/${CACHE_NAMESPACE_ID}/values/${encodeURIComponent(write.key)}?expiration_ttl=${write.ttl}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'text/plain' },
    body: write.value,
  });
  if (!res.ok)
    throw new Error(`KV put ${write.key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** @param {string} slug @param {'ok'|'error'|'skipped'} status @param {number} records @param {number} ms @param {string|null} message */
async function refreshLog(slug, status, records, ms, message) {
  await sql(
    'INSERT INTO refresh_log (source_slug, status, records, duration_ms, message) VALUES (?1, ?2, ?3, ?4, ?5)',
    [slug, status, records, ms, message],
  );
}

/** @param {string} slug */
async function lastOkAgeMs(slug) {
  const [row] = await sql(
    "SELECT MAX(created_at) AS last_ok FROM refresh_log WHERE source_slug = ?1 AND status = 'ok'",
    [slug],
  );
  if (!row?.last_ok) return Infinity;
  return Date.now() - Date.parse(`${String(row.last_ok).replace(' ', 'T')}Z`);
}

// The sources only read FIXTURE_FALLBACK from the bindings; prod pins it "false" and so do we —
// a runner that cannot read the origin must fail loudly, never cache the bundled fixtures as live.
const env = /** @type {CloudflareBindings} */ (
  /** @type {unknown} */ ({ FIXTURE_FALLBACK: 'false' })
);

let failed = 0;
for (const source of listSources().filter(isRunnerFed)) {
  const start = Date.now();
  try {
    const age = await lastOkAgeMs(source.slug);
    if (age < FRESH_ENOUGH_MS) {
      console.log(`${source.slug}: refreshed ${Math.round(age / 3_600_000)} h ago, skipping`);
      continue;
    }
    const records = await source.fetchFresh(env);
    if (records.length === 0) throw new Error('refresh returned 0 records');
    const lastRefreshedAt = new Date().toISOString();
    for (const write of snapshotWrites(source, records, lastRefreshedAt)) await kvPut(write);
    await refreshLog(source.slug, 'ok', records.length, Date.now() - start, 'runner');
    console.log(`${source.slug}: ${records.length} records written from the runner`);
  } catch (err) {
    const message = `runner: ${err instanceof Error ? err.message : String(err)}`;
    // An origin that answered 5xx on every read the source allowed (OriginUnavailableError,
    // refresh-uk-insolvency-2026-10-11) is the origin's day off, not a failed refresh: a
    // `skipped` row keeps the fact without listing the source under `refresh errors` (the last
    // snapshot is served as before; two such days surface through the stale reading).
    const status = isOriginUnavailable(err) ? 'skipped' : 'error';
    if (status === 'error') failed += 1;
    console.error(`${source.slug}: ${status}: ${message}`);
    await refreshLog(source.slug, status, 0, Date.now() - start, message).catch((e) =>
      console.error(`${source.slug}: refresh_log write failed too: ${e.message}`),
    );
  }
}
// IndexNow from the runner (2026-10-07, queue `indexnow-from-runner`): api.indexnow.org answers
// 429 to every POST from Cloudflare Workers egress (shared IPs; each wave on 10-05 and 10-06) and
// 200 to a GitHub runner (uk-insolvency's ping from this job the same morning), so the one daily
// submission is made here, after the Worker's waves: every source with an `ok` refresh_log row in
// the last 26 h, its parent /stats page plus the facet pages from the stats blob the refresh left
// in KV. Only uk-trademark-journal has facets (45 Nice classes; the sitemap's 62 /stats URLs are
// 17 parents + those classes), so a day it is stale reads one URL per refreshed source. The
// result lands in dist/indexnow.json next to this bundle for metrics.mjs (`indexnow: N urls S`
// in the Daily numbers row); a failure is printed, never fails the job.
/** @param {string} key */
async function kvGet(key) {
  const url = `${API}/storage/kv/namespaces/${CACHE_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: auth });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`KV get ${key}: ${res.status}`);
  return res.json();
}

async function submitStatsPages() {
  const rows = await sql(
    "SELECT DISTINCT source_slug FROM refresh_log WHERE status = 'ok' AND created_at > datetime('now','-26 hours')",
  );
  const slugs = rows.map((r) => String(r.source_slug));
  const urls = [];
  for (const slug of slugs) {
    const blob = await kvGet(statsKey(slug)).catch(() => null);
    urls.push(...statsUrlsFor(PUBLIC_BASE_URL, slug, blob?.stats ?? null));
  }
  const result = await postIndexNow({ baseUrl: PUBLIC_BASE_URL, key: INDEXNOW_KEY, urls });
  const out = { date: new Date().toISOString().slice(0, 10), sources: slugs.length, ...result };
  await writeFile(new URL('./indexnow.json', import.meta.url), JSON.stringify(out));
  console.log(
    `indexnow: ${result.urls} urls, status ${result.status ?? 'n/a'}, ${slugs.length} sources refreshed in 26 h`,
  );
}
await submitStatsPages().catch((e) => console.error(`indexnow: ${e.message}`));

// Wave log reading (2026-10-09, queue `wave-log-reading`): a wave killed at the 15-minute Cron
// Trigger limit writes no refresh_log row, and nothing in a sandbox or the relay can read Worker
// logs — uk-trademark-journal's silent nights (10-05..10-08) were each guessed at. This runner
// holds the deploy token, so for every source with no `ok` row in 26 h or an error row today it
// asks Workers observability (wrangler.jsonc `observability.enabled`) for the last 24 h of lines
// mentioning the slug, prints them here and leaves them in dist/wave-logs.json for metrics.mjs
// (`wave log: …` in the Daily numbers row). A token without the observability scope reads
// `n/a (HTTP 403 …)` — then the scope is the one thing to add. Never fails the job.
// Cron outcome (2026-10-17, queue `wave-log-cron-outcome-reading`): the slug search's first real
// test (10-16) returned request lines and @x402/hono's Ajv warning only, and the journal's 06:05
// wave left no line at all. So noise is dropped (lib `dropNoise`) and a second query, one per
// Cron Trigger, reads the wave's own invocation — `$workers.outcome`, wall time — which the
// platform records even when the Worker wrote nothing. The first invocation row's keys are
// printed so the job log shows the live shape the parser was written against.

/** @param {Record<string, unknown>} query */
async function observabilityQuery(query) {
  const res = await fetch(`${API}${WAVE_LOG_QUERY_PATH}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(query),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    const hint = res.status === 403 ? ' (token lacks Workers Observability Read)' : '';
    return { status: res.status, body: null, reason: `HTTP ${res.status}${hint}`, bodyText };
  }
  try {
    return { status: res.status, body: JSON.parse(bodyText), reason: null, bodyText };
  } catch {
    return { status: res.status, body: null, reason: 'unparseable body', bodyText };
  }
}

/** @type {Map<string, Promise<import('../src/lib/wave-logs.ts').WaveInvocationResult>>} */
const invocationByCron = new Map();
/** @param {string} cron @param {number} now */
function readWaveInvocation(cron, now) {
  const cached = invocationByCron.get(cron);
  if (cached) return cached;
  const pending = (async () => {
    try {
      const q = await observabilityQuery(waveInvocationQuery(cron, now));
      if (q.reason) {
        console.error(`wave cron ${cron}: ${q.reason} ${q.bodyText.slice(0, 300)}`);
        return { cron, status: q.status, invocations: [], reason: q.reason };
      }
      const invocations = parseWaveInvocations(q.body, cron);
      console.log(`wave cron ${cron}: ${invocations.length} invocation(s) in 26 h`);
      for (const i of invocations)
        console.log(
          `  ${i.at} outcome=${i.outcome} wall=${i.wallTimeMs ?? 'n/a'}ms cpu=${i.cpuTimeMs ?? 'n/a'}ms cron=${i.cron ?? 'unread'}`,
        );
      // The raw row is printed when none parsed and when a parsed row names no cron (2026-10-22:
      // the 10-21 rows carried none, so the next log shows where the live shape keeps it).
      if (invocations.length === 0 || invocations.some((i) => i.cron === null)) {
        const result = q.body?.result ?? q.body;
        const rows = result?.events?.events ?? result?.events ?? result;
        const first = Array.isArray(rows) ? rows[0] : undefined;
        console.log(
          `wave cron ${cron}: response keys ${Object.keys(result ?? {}).join(',')}; first row ${
            first ? JSON.stringify(first).slice(0, 600) : 'none'
          }`,
        );
      }
      return { cron, status: q.status, invocations, reason: null };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`wave cron ${cron}: ${reason}`);
      return { cron, status: 0, invocations: [], reason };
    }
  })();
  invocationByCron.set(cron, pending);
  return pending;
}

async function readWaveLogs() {
  const rows = await sql(
    "SELECT source_slug, MAX(CASE WHEN status = 'ok' THEN created_at END) AS last_ok, SUM(status = 'error' AND created_at > datetime('now','-1 day')) AS errors_today FROM refresh_log WHERE created_at > datetime('now','-30 days') GROUP BY source_slug HAVING last_ok IS NULL OR last_ok < datetime('now','-26 hours') OR errors_today > 0",
  );
  const stale = new Set(rows.map((r) => String(r.source_slug)));
  // Missing facet pages (2026-10-27, gankdat `sitemap-5xx-verify`): the journal's ok row hid a
  // facet pass that wrote nothing — every Nice-class page a 503 while this read saw no stale
  // source — so a source whose stats blob holds fewer facet pages than its spec lists is read too.
  for (const source of listSources()) {
    const facets = source.stats?.facets;
    if (!facets) continue;
    const blob = await kvGet(statsKey(source.slug)).catch(() => null);
    const declared = facets.reduce((n, f) => n + f.values.length, 0);
    const present = (blob?.stats?.facets ?? []).reduce((n, f) => n + f.pages.length, 0);
    if (present < declared) {
      console.log(
        `stats facets ${source.slug}: ${present} of ${declared} pages in the blob${blob ? '' : ' (no blob)'}`,
      );
      stale.add(source.slug);
    }
  }
  const slugs = [...stale].sort();
  const now = Date.now();
  const sourceBySlug = new Map(listSources().map((s) => [s.slug, s]));
  /** @type {Record<string, import('../src/lib/wave-logs.ts').WaveLogResult>} */
  const sources = {};
  for (const slug of slugs) {
    const source = sourceBySlug.get(slug);
    const cron = source ? cronOfSource(source) : null;
    const wave = cron ? await readWaveInvocation(cron, now) : null;
    try {
      const q = await observabilityQuery(waveLogQuery(slug, now));
      if (q.reason) {
        sources[slug] = { status: q.status, events: [], reason: q.reason, wave };
        console.error(`wave log ${slug}: ${q.reason} ${q.bodyText.slice(0, 300)}`);
        continue;
      }
      // The slug needle matches every request line naming the slug (a relay round or a crawler
      // fills the 20 newest lines within minutes), so a second query reads the Worker's own
      // structured lines for the source — `"source":"<slug>"` is how every JSON event names it
      // (2026-10-27, gankdat `sitemap-5xx-verify`: the 06:05 pass's stats_precompute_failed line
      // sat behind ten request lines of the morning).
      const structured = await observabilityQuery(waveLogQuery(`"source":"${slug}"`, now));
      const own = structured.reason ? [] : parseWaveLogEvents(structured.body);
      if (structured.reason) console.error(`wave log ${slug} (structured): ${structured.reason}`);
      const seen = new Set(own.map((e) => `${e.at} ${e.message}`));
      const all = [
        ...own,
        ...parseWaveLogEvents(q.body).filter((e) => !seen.has(`${e.at} ${e.message}`)),
      ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      const events = dropNoise(all);
      sources[slug] = { status: q.status, events, reason: null, lines: all.length, wave };
      console.log(`wave log ${slug}: ${all.length} line(s) in 24 h, ${events.length} readable`);
      if (all.length === 0)
        console.log(
          `wave log ${slug}: response keys ${Object.keys(q.body.result ?? q.body).join(',')}`,
        );
      for (const e of all)
        console.log(
          `  ${e.at} [${e.level}]${events.includes(e) ? '' : ' (noise)'} ${e.message.slice(0, 400)}`,
        );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      sources[slug] = { status: 0, events: [], reason, wave };
      console.error(`wave log ${slug}: ${reason}`);
    }
  }
  const out = { date: new Date().toISOString().slice(0, 10), sources };
  await writeFile(new URL('./wave-logs.json', import.meta.url), JSON.stringify(out));
  console.log(
    `wave log: ${slugs.length} stale or erroring source(s) queried, ${invocationByCron.size} wave(s)`,
  );
}
await readWaveLogs().catch((e) => console.error(`wave log: ${e.message}`));
process.exit(failed ? 1 : 0);
