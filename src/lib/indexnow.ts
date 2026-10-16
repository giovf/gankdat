import type { SourceStats } from './stats';

// IndexNow (indexnow.org): one POST of changed URLs, authenticated by a key file at the
// site root, feeds Bing's index — which DuckDuckGo, Copilot and ChatGPT web search read.
// No account, no identity: the only indexing signal the repo can send itself while the
// Search Console reading stays owner-blocked (queue `search-console-stats-indexing`).
// The key is deliberately a plain wrangler var, not a secret: anyone can read it from the
// key file anyway, and it proves nothing but control of the host.
// The POST is made from the GitHub runner (scripts/runner-refresh.mjs, daily after the
// waves), never from the Worker: api.indexnow.org rate-limits by source IP and answered 429
// to every wave-end ping from Workers' shared egress (2026-10-05/06) while the runner's own
// post got 200 — queue `indexnow-from-runner`. The Worker only serves the key file.

export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/IndexNow';
/** The protocol's ceiling per POST. */
export const INDEXNOW_MAX_URLS = 10_000;
/** 8–128 of [a-zA-Z0-9-] per the protocol; the Worker only serves a key of this shape. */
export const INDEXNOW_KEY_SHAPE = /^[A-Za-z0-9-]{8,128}$/;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The public pages one source's refresh changed: the parent stats page and every facet sub-page. */
export function statsUrlsFor(baseUrl: string, slug: string, stats: SourceStats | null): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  const urls = [`${base}/stats/${slug}`];
  for (const facet of stats?.facets ?? []) {
    for (const page of facet.pages) {
      urls.push(`${base}/stats/${slug}/${facet.segment}/${encodeURIComponent(page.value)}`);
    }
  }
  return urls;
}

export interface IndexNowResult {
  /** URLs submitted (after de-duplication). */
  urls: number;
  /** HTTP status of the last call; null when nothing was sent (no key, no URLs). */
  status: number | null;
  /** Number of POSTs made (URLs are chunked at INDEXNOW_MAX_URLS). */
  calls: number;
}

/**
 * POST `urls` to IndexNow for the host of `baseUrl`, chunked at `maxPerCall`. Pure: no
 * bindings, so the GitHub runner (runner-refresh.mjs) can call it too. Never throws — a
 * network error reads as status 0 so a wave is never failed by an indexing hint.
 */
export async function postIndexNow(opts: {
  baseUrl: string;
  key: string;
  urls: string[];
  fetchImpl?: FetchLike;
  maxPerCall?: number;
}): Promise<IndexNowResult> {
  const key = opts.key.trim();
  const unique = [...new Set(opts.urls)];
  if (!INDEXNOW_KEY_SHAPE.test(key) || unique.length === 0) {
    return { urls: 0, status: null, calls: 0 };
  }
  const base = opts.baseUrl.replace(/\/+$/, '');
  const host = new URL(base).host;
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const max = Math.max(1, Math.min(opts.maxPerCall ?? INDEXNOW_MAX_URLS, INDEXNOW_MAX_URLS));
  let status: number | null = null;
  let calls = 0;
  for (let i = 0; i < unique.length; i += max) {
    const urlList = unique.slice(i, i + max);
    calls += 1;
    try {
      const res = await fetchImpl(INDEXNOW_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host, key, keyLocation: `${base}/${key}.txt`, urlList }),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    // A rejected key or a throttle will not change on the next chunk; stop and report it.
    if (status !== 200 && status !== 202) break;
  }
  return { urls: unique.length, status, calls };
}
