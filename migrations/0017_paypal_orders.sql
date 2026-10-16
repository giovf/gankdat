-- Migration: PayPal credit-pack orders (PayPal AI Hackathon entry, 2026-10-11).
-- One row per order created through the Orders API v2 (sandbox); the row is the
-- capture guard: a capture grants credits only when it flips status from
-- 'created' to 'completed' (UPDATE … WHERE status = 'created'), so a replayed
-- capture or a second return-URL hit never grants twice.
-- Apply locally:   npx wrangler d1 migrations apply DB --local
-- Production: CI applies migrations before deploying (gankdat.yml).
CREATE TABLE paypal_orders (
  order_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  pack TEXT NOT NULL,
  credits INTEGER NOT NULL,
  amount_usd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  capture_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  captured_at TEXT
);

CREATE INDEX idx_paypal_orders_account ON paypal_orders (account_id, created_at DESC);
