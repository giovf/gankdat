-- Migration: billing idempotency — a Stripe event id may credit the ledger
-- at most once (webhook retries/replays become no-ops).
-- Apply locally:   npx wrangler d1 migrations apply DB --local
-- Apply to production (ASK FIRST per CLAUDE.md): npx wrangler d1 migrations apply DB --remote
CREATE UNIQUE INDEX idx_credit_ledger_stripe_ref
  ON credit_ledger (stripe_ref)
  WHERE stripe_ref IS NOT NULL;
