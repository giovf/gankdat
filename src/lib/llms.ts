import { PAID_PLANS } from '../billing/plans';
import { FREE_TIER_CREDITS } from './constants';
import { creditCost } from '../metering/costs';
import { buildQuerySchema } from '../sources/query';
import { hasChangeFeed, listSources } from '../sources/registry';

// llms.txt generated from the source registry (same single-source-of-truth
// pattern as lib/openapi.ts): a new registry entry appears in the Datasets and
// MCP-tools sections automatically, and pricing derives from plans.json, so
// this LLM-discovery surface cannot drift from the product. Positioning copy
// (the blockquote) is assembled from source titles; origin-feed naming lives
// in each source's description.

function datasetLines(baseUrl: string): string {
  return listSources()
    .map((source) => {
      const params = Object.keys(buildQuerySchema(source).shape).join(', ');
      const cost = creditCost(source);
      const costNote = cost === 1 ? '' : ` Costs ${cost} credits/request.`;
      const lookup = source.lookup
        ? ` One record per request, named by ${source.lookup.keys.join(' or ')} (e.g. ?${Object.entries(
            source.lookup.example,
          )
            .map(([k, v]) => `${k}=${v}`)
            .join('&')}).`
        : '';
      return `- GET ${baseUrl}/v1/data/${source.slug} — ${source.description}${costNote}${lookup}\n  Filters: ${params}.`;
    })
    .join('\n');
}

export function buildLlmsTxt(baseUrl: string): string {
  const sources = listSources();
  const catalog = sources.map((s) => s.title).join('; ');
  const feeds = sources.filter(hasChangeFeed);
  const tools = [
    'list_sources',
    'get_usage',
    'request_api_key',
    'claim_api_key',
    ...(feeds.length > 0 ? ['get_changes'] : []),
    ...sources.map((s) => `query_${s.slug.replaceAll('-', '_')}`),
  ].join(', ');
  const minGbp = Math.min(...Object.values(PAID_PLANS).map((p) => p.gbpPerMonth));

  return `# gankdat

> ${catalog} — as clean JSON, one schema, refreshed daily from official
> government feeds; no scraping. Built for developers and AI agents. Native
> MCP server + x402 pay-per-request. Licence and personal-data posture are
> stated per dataset in ${baseUrl}/terms (OGL v3 sources; Blind Mode where
> stated; sanctions data served as published, minimized, for compliance use).

Base URL: ${baseUrl}
Machine-readable spec: ${baseUrl}/openapi.json

## Auth & pricing

- Free key: sign in at ${baseUrl}/account (email magic link) and create a key
  → ${FREE_TIER_CREDITS} requests/month, no card. Agents without a key can pay
  per request via x402 (see below) — no signup.
- Agents can sign the user up without a browser: POST ${baseUrl}/v1/auth/agent-signup
  {"email":"…","client_name":"…"} (or the MCP tool request_api_key) emails the
  user a one-click approval link with a short code; show them the code, then
  POST ${baseUrl}/v1/auth/agent-signup/claim {"request_id","claim_secret"} (or
  claim_api_key) every 15 s until status is "approved" — it returns the key
  once. No key needed for these two calls.
- MCP clients that follow a 401 challenge (Claude, Cursor, ChatGPT) sign the user in
  with OAuth instead: ${baseUrl}/.well-known/oauth-protected-resource/mcp names the
  issuer (CIMD + PKCE, no client secret); the connect_account tool, or a spent
  preview budget, triggers it. Tokens bill the account like a key.
- Send the key as \`Authorization: Bearer fapi_...\` on every data request.
- 1 credit = 1 request; paid plans from £${minGbp}/mo (billed GBP/USD/EUR by
  location); usage at GET /v1/usage (free).
- Every response: {"ok":true,"data":[...],"meta":{...}} or
  {"ok":false,"error":{"code","message","docs_url"}}.

## Datasets

- GET ${baseUrl}/v1/data — list sources and their filter params (public).
${datasetLines(baseUrl)}

## Change feeds (what changed since a date)

Register datasets diff themselves against the previous day's refresh, so an
agent polls the delta instead of re-reading a whole register — no competitor
publishes official-source deltas. Rows added, removed or changed, newest
first, 90-day history, 1 credit per page: a daily diff of every register fits
the free tier.

${feeds.map((s) => `- GET ${baseUrl}/v1/changes/${s.slug} — ${s.title}`).join('\n')}
  Params: since (YYYY-MM-DD, default 7 days ago), change (added|removed|changed), page, per_page,
  plus the dataset's own filters and q applied to the changed record (a watch in one call, e.g.
  /v1/changes/uk-trademark-journal?classes=09&q=<mark>).
- MCP tool: get_changes (source, since, change, filter). Activity per day is shown on
  each dataset's /stats page.

## For AI agents

- MCP server (Streamable HTTP): ${baseUrl}/mcp — anonymous initialize,
  tools/list and the two sign-up tools; data tools use the same bearer key.
  Tools: ${tools}. Structured JSON results with credits_remaining in meta.
- x402 v2 pay-per-request (no account, USDC on Base; discovery metadata for the
  x402 Bazaar): GET /x402/data/{source} → HTTP 402 whose PAYMENT-REQUIRED header
  carries the price, the query schema and an output example → pay → retry with
  PAYMENT-SIGNATURE. ~$0.005/request.

## Docs

- Human docs: ${baseUrl}/docs
- Dataset statistics (citable, computed daily): ${baseUrl}/stats — one page
  per dataset at /stats/{slug}
- Quickstart: get a key, then
  curl -H "Authorization: Bearer fapi_..." "${baseUrl}/v1/data/${sources[0]?.slug ?? 'uk-tenders'}?per_page=3"
`;
}

let cached: string | undefined;

/** Registry + base URL are static per deployment, so the text is built once. */
export function getLlmsTxt(baseUrl: string): string {
  cached ??= buildLlmsTxt(baseUrl);
  return cached;
}
