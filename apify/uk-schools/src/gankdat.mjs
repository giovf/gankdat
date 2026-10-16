// Shared client for gankdat-backed Apify actors: paginates a dataset query (or, in changes
// mode, the register's change feed), pushes records to the run's dataset and charges one
// pay-per-event "result" per record, stopping cleanly at the user's spending limit.
import { Actor, log } from 'apify';

const API = 'https://gankdat.com/v1';
const PER_PAGE = 100;
const USER_AGENT = 'gankdat-apify-actor/1.2';

async function apiGet(key, url, params) {
  for (;;) {
    const qs = new URLSearchParams(params);
    const res = await fetch(`${url}?${qs}`, {
      headers: { authorization: `Bearer ${key}`, 'user-agent': USER_AGENT },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '5') * 1000;
      log.warning(`Rate limited by the API; waiting ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    return res;
  }
}

/**
 * @param {string} dataset   gankdat dataset slug
 * @param {Record<string, string|number|boolean|undefined>} filters query params
 * @param {number} maxResults hard cap from the actor input
 * @param {{ mode?: string, since?: string, change?: string }} [feed] changes mode: rows added,
 *   removed or changed since `since` (default: the last 7 days), optionally one `change` kind;
 *   each pushed item is the record plus `change` and `changed_at`. Only registers with a stable
 *   record id have a feed (the API answers 404 otherwise) — the actor input offers the mode
 *   only there.
 */
export async function runDatasetActor(dataset, filters, maxResults, feed = {}) {
  const key = process.env.GANKDAT_API_KEY;
  if (!key) throw new Error('GANKDAT_API_KEY is not configured on this actor');
  const changes = feed.mode === 'changes';
  const params = Object.fromEntries(
    Object.entries({
      ...filters,
      ...(changes ? { since: feed.since, change: feed.change } : {}),
    }).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  const url = `${API}/${changes ? 'changes' : 'data'}/${dataset}`;
  let page = 1;
  let pushed = 0;
  let total = null;
  for (;;) {
    const res = await apiGet(key, url, {
      ...params,
      page: String(page),
      per_page: String(PER_PAGE),
    });
    if (!res.ok) throw new Error(`gankdat API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    const rows = body.data ?? [];
    total = body.meta?.total ?? total;
    if (page === 1) {
      log.info(
        changes
          ? `${total ?? '?'} changes since ${body.meta?.since ?? feed.since ?? '7 days ago'}; returning up to ${maxResults}`
          : `${total ?? '?'} matching records; returning up to ${maxResults}`,
      );
    }
    for (const row of rows) {
      if (pushed >= maxResults) break;
      const charge = await Actor.charge({ eventName: 'result' });
      if (charge.eventChargeLimitReached) {
        log.warning(
          'Spending limit reached; stopping. Raise the max total charge to get more results.',
        );
        await Actor.setStatusMessage(`Stopped at ${pushed} results (spending limit).`);
        return pushed;
      }
      await Actor.pushData(
        changes ? { ...row.record, change: row.change, changed_at: row.changed_at } : row,
      );
      pushed += 1;
    }
    if (pushed >= maxResults || rows.length < PER_PAGE) break;
    page += 1;
  }
  await Actor.setStatusMessage(
    changes
      ? `Done: ${pushed} changes (${total ?? 0} since ${feed.since ?? '7 days ago'}; schedule this run daily to monitor the register).`
      : `Done: ${pushed} results (${total ?? 0} matched, refreshed daily from the official source).`,
  );
  return pushed;
}

/** Top-level fields whose JSON differs between two records of the same key. */
export function changedFields(previous, current) {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(current ?? {})]);
  return [...keys]
    .filter((k) => JSON.stringify(previous?.[k] ?? null) !== JSON.stringify(current?.[k] ?? null))
    .sort();
}

/** A key-value store key for a lookup value (Apify allows [a-zA-Z0-9!-_.'()] only). */
const storeKeyOf = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9!\-_.'()]+/g, '_')
    .slice(0, 200);

/**
 * Lookup actor (2026-10-07, uk-company-profiles): the input is the buyer's own list of keys,
 * one API lookup each, one `result` per record pushed. In changes mode the previous run's
 * records — this actor's named key-value store `gankdat-<dataset>-baseline`, one entry per
 * value — are the baseline: a value seen for the first time is `added`, one whose record
 * differs is `changed` (with `changed_fields`), one the register no longer returns is
 * `removed`; an unchanged one pushes nothing and costs nothing. Values dropped from the input
 * are simply no longer checked.
 *
 * @param {string} dataset   gankdat lookup dataset slug
 * @param {string | ((value: string) => string)} keyParam the query param a value is sent as
 * @param {string[]} values  the list from the actor input
 * @param {number} maxResults hard cap from the actor input
 * @param {{ mode?: string }} [feed] `changes` for the monitor
 */
export async function runLookupActor(dataset, keyParam, values, maxResults, feed = {}) {
  const key = process.env.GANKDAT_API_KEY;
  if (!key) throw new Error('GANKDAT_API_KEY is not configured on this actor');
  const changes = feed.mode === 'changes';
  const wanted = [...new Set((values ?? []).map((v) => String(v).trim()).filter((v) => v !== ''))];
  if (wanted.length === 0) throw new Error('Give at least one company (number or name) to look up');
  const store = changes ? await Actor.openKeyValueStore(`gankdat-${dataset}-baseline`) : null;
  const url = `${API}/data/${dataset}`;
  let pushed = 0;
  let notFound = 0;
  let unchanged = 0;
  log.info(
    changes
      ? `Monitoring ${wanted.length} companies against the previous run; returning up to ${maxResults} changes`
      : `Looking up ${wanted.length} companies; returning up to ${maxResults}`,
  );

  const push = async (item) => {
    const charge = await Actor.charge({ eventName: 'result' });
    if (charge.eventChargeLimitReached) {
      log.warning(
        'Spending limit reached; stopping. Raise the max total charge to get more results.',
      );
      await Actor.setStatusMessage(`Stopped at ${pushed} results (spending limit).`);
      return false;
    }
    await Actor.pushData(item);
    pushed += 1;
    return true;
  };

  for (const value of wanted) {
    if (pushed >= maxResults) break;
    const param = typeof keyParam === 'function' ? keyParam(value) : keyParam;
    const res = await apiGet(key, url, { [param]: value, per_page: '1' });
    if (res.status === 400) {
      log.warning(`${value}: rejected by the API (${(await res.text()).slice(0, 160)})`);
      continue;
    }
    if (!res.ok) throw new Error(`gankdat API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const record = (await res.json()).data?.[0] ?? null;
    if (!changes) {
      if (record) {
        if (!(await push(record))) return pushed;
      } else {
        notFound += 1;
        log.warning(`${value}: no such company on the register`);
      }
      continue;
    }
    const storeKey = storeKeyOf(value);
    const previous = (await store.getValue(storeKey)) ?? null;
    const changedAt = new Date().toISOString();
    if (!record) {
      notFound += 1;
      if (previous) {
        if (
          !(await push({
            ...previous,
            change: 'removed',
            changed_at: changedAt,
            changed_fields: [],
          }))
        )
          return pushed;
        await store.setValue(storeKey, null);
      }
      continue;
    }
    if (!previous) {
      if (!(await push({ ...record, change: 'added', changed_at: changedAt, changed_fields: [] })))
        return pushed;
    } else {
      const fields = changedFields(previous, record);
      if (fields.length === 0) {
        unchanged += 1;
      } else if (
        !(await push({
          ...record,
          change: 'changed',
          changed_at: changedAt,
          changed_fields: fields,
        }))
      ) {
        return pushed;
      }
    }
    await store.setValue(storeKey, record);
  }
  await Actor.setStatusMessage(
    changes
      ? `Done: ${pushed} changes across ${wanted.length} companies (${unchanged} unchanged, ${notFound} not on the register); schedule this run daily to monitor your list.`
      : `Done: ${pushed} companies (${notFound} not found), read live from the official register.`,
  );
  return pushed;
}
