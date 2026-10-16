-- Migration 0005: email-account identity.
-- Accounts (keyed by normalized email) become the single identity: plan,
-- entitlement, usage, and Stripe billing all hang off the account, and API keys
-- are credentials that inherit their account's plan. This fixes the per-key vs
-- per-email incoherence (a paid plan now applies to every key under the email,
-- and re-issuing a key under a paid email inherits the plan).
-- stripe_customers and credit_ledger are rebuilt because SQLite can't drop their
-- NOT NULL key_id in place; the account becomes the billing/ledger subject.
-- Apply locally:   npx wrangler d1 migrations apply DB --local
-- Apply to production (ASK FIRST per CLAUDE.md): npx wrangler d1 migrations apply DB --remote

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,          -- always stored normalized (lowercased)
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 1) Link API keys to accounts (plain column; SQLite can't add a table-level FK
--    retroactively). Backfill one account per distinct lowercased email; if any
--    of that email's keys already carries a paid plan, the account adopts it.
ALTER TABLE api_keys ADD COLUMN account_id TEXT;

INSERT INTO accounts (id, email, plan)
SELECT lower(hex(randomblob(16))), e.email_norm, e.plan
FROM (
  SELECT
    lower(email) AS email_norm,
    COALESCE(MAX(CASE WHEN plan != 'free' THEN plan END), 'free') AS plan
  FROM api_keys
  GROUP BY lower(email)
) AS e;

UPDATE api_keys
   SET account_id = (SELECT a.id FROM accounts a WHERE a.email = lower(api_keys.email));

CREATE INDEX idx_api_keys_account ON api_keys (account_id);

-- 2) Rebuild stripe_customers as account-keyed (one Stripe customer per account).
CREATE TABLE stripe_customers_new (
  stripe_customer_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  plan TEXT,
  status TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO stripe_customers_new (stripe_customer_id, account_id, plan, status, updated_at)
  SELECT sc.stripe_customer_id,
         (SELECT k.account_id FROM api_keys k WHERE k.id = sc.key_id),
         sc.plan, sc.status, sc.updated_at
  FROM stripe_customers sc;
DROP TABLE stripe_customers;
ALTER TABLE stripe_customers_new RENAME TO stripe_customers;
CREATE UNIQUE INDEX idx_stripe_customers_account ON stripe_customers (account_id);

-- 3) Rebuild credit_ledger as account-keyed (grants are account-level; key_id is
--    now optional provenance). Preserve ids, append-only nature, and the
--    stripe_ref idempotency index from 0003.
CREATE TABLE credit_ledger_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  key_id TEXT,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  stripe_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO credit_ledger_new (id, account_id, key_id, delta, reason, stripe_ref, created_at)
  SELECT cl.id,
         (SELECT k.account_id FROM api_keys k WHERE k.id = cl.key_id),
         cl.key_id, cl.delta, cl.reason, cl.stripe_ref, cl.created_at
  FROM credit_ledger cl;
DROP TABLE credit_ledger;
ALTER TABLE credit_ledger_new RENAME TO credit_ledger;
CREATE INDEX idx_credit_ledger_account ON credit_ledger (account_id, created_at DESC);
CREATE UNIQUE INDEX idx_credit_ledger_stripe_ref
  ON credit_ledger (stripe_ref) WHERE stripe_ref IS NOT NULL;
