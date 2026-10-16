-- Migration: waitlist — pre-launch email capture (GDPR-minimal: email only,
-- no tracking fields; exported manually, no email provider in v1).
-- Apply locally:   npx wrangler d1 migrations apply DB --local
-- Apply to production (ASK FIRST per CLAUDE.md): npx wrangler d1 migrations apply DB --remote
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
