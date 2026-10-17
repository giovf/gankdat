> **Public mirror.** This repository is a read-only snapshot of the gankdat service, synced
> automatically from a private monorepo (commit `9f0c64a80d67`, 2026-10-17). Internal planning
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
