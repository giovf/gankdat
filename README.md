> **Public mirror.** This repository is a read-only snapshot of the gankdat service, synced
> automatically from a private monorepo (commit `32548d655d48`, 2026-10-25). Internal planning
> documents are not mirrored. Issues are welcome here; pull requests are read and applied upstream.
> Live service: https://gankdat.com · MCP: https://gankdat.com/mcp · docs: https://gankdat.com/docs

# gankdat

A niche data API sold on usage-based pricing to **human developers** (self-serve
Stripe billing) and **AI agents** (MCP server + x402 USDC micropayments). v1
ships official open data across two bundles — bid intelligence (UK planning
applications, UK + EU procurement notices) and counterparty risk (UK
sanctions, US federal exclusions, UK corporate insolvency, UK company
incorporations, UK food hygiene ratings, UK licensed visa sponsors, England & Wales charities, CQC care locations) — normalized to clean JSON behind a swappable data-source
layer, so datasets are added or retired without touching the platform (auth,
metering, billing, MCP, x402, docs). Large lists (e.g. US exclusions) sit in
D1; smaller feeds are cached KV snapshots.

Built with TypeScript (strict) + [Hono](https://hono.dev) on Cloudflare
Workers. Storage: Workers KV + D1. Data refresh: Cron Triggers. Everything is
designed for solo, near-zero-touch operation.

## Running it

```bash
npm install
npm run dev        # wrangler dev → http://localhost:8787
```

Other scripts: `npm run build` (dry-run deploy), `npm run lint`,
`npm run typecheck`, `npm test`, `npm run format`, `npm run deploy` (real
deploy — needs a Cloudflare account), `npm run cf-typegen` (regenerate binding
types after editing `wrangler.jsonc`).

Local secrets (Stripe test keys etc.) go in `.dev.vars` — see the documented
variable list in `.env.example`.

## Try the PayPal credit-pack checkout (sandbox)

Credit packs are sold through PayPal's **sandbox** (Orders API v2) — no real money can move. The
AI part is the buyer: an MCP client starts the checkout when it runs out of credits, hands the
human PayPal's approval link and never sees a card. Three ways to run it against the live service:

1. **Human path (2 minutes).** Go to https://gankdat.com/account, enter any email address and
   click the sign-in link you receive (free plan, 250 credits). Under "Credit packs" choose a
   pack: you land on PayPal's sandbox checkout. Approve it with a PayPal sandbox personal account
   (free: developer.paypal.com → Testing Tools → Sandbox Accounts → Create account → Personal) and
   PayPal returns you to the account page with the credits added and `topup` in the usage line.
2. **Agent path over MCP (5 minutes).** In Claude, Cursor or ChatGPT add the MCP server
   `https://gankdat.com/mcp` (no key needed to list tools and preview data). Ask the agent to buy
   1,000 credits: it calls `buy_credits`, which starts a sign-in (the same email link), creates the
   sandbox order and returns PayPal's approval link; approve it as in step 1, then tell the agent
   to continue: it calls `confirm_credit_purchase` and the next data tool call shows the credits
   coming from the top-up balance.
3. **REST path (curl).** With the API key from the account page:
   `POST https://gankdat.com/v1/billing/paypal/orders` with body `{"pack":"pack_1k"}` returns
   `approve_url`; after approval, `POST https://gankdat.com/v1/billing/paypal/orders/<id>/capture`
   adds the credits; any `GET /v1/data/<dataset>` then carries `X-Credits-Source`.

Code: `src/billing/paypal.ts` (orders + capture), `src/metering/budget.ts` (plan first, then
top-up), `src/mcp/server.ts` (the two tools), `test/paypal.spec.ts`. Locally, `npm run dev` with
`PAYPAL_SANDBOX_CLIENT_ID` / `PAYPAL_SANDBOX_SECRET` in `.dev.vars` lights the same surfaces;
`scripts/paypal-walkthrough.mjs` runs the five-call agent path from a terminal.

## Dev container

Open the folder in VS Code and choose **"Reopen in Container"** — you get
Node 22, Claude Code, and Taskmaster preinstalled, with per-project volumes
for auth, `node_modules`, and shell history. Port 8787 is forwarded.

## Project docs

- `docs/ARCHITECTURE.md` — the stable architecture summary
- `.taskmaster/docs/prd.md` — the approved PRD; backlog in `.taskmaster/tasks/`
- `.taskmaster/docs/scope.md` + `niche-analysis.md` — business rationale
- Daily loop: `task-master next` → implement → `task-master set-status
  --id <id> --status done`
