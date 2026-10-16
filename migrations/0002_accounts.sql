-- Migration: accounts — API keys, append-only credit ledger, Stripe linkage.
-- Apply locally:   npx wrangler d1 migrations apply DB --local
-- Apply to production (ASK FIRST per CLAUDE.md): npx wrangler d1 migrations apply DB --remote

-- Raw keys are never stored: key_hash is hex SHA-256 of the issued key.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  credits_granted INTEGER NOT NULL DEFAULT 250,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

CREATE INDEX idx_api_keys_email ON api_keys (email);

-- Append-only: rows are inserted, never updated or deleted. Balance is the
-- sum of deltas; usage rollups debit, grants credit.
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id TEXT NOT NULL REFERENCES api_keys (id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  stripe_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_credit_ledger_key ON credit_ledger (key_id, created_at DESC);

CREATE TABLE stripe_customers (
  stripe_customer_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES api_keys (id),
  plan TEXT,
  status TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
