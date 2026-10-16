-- Migration: refresh_log — one row per source-refresh attempt (cron or cache miss).
-- Apply locally (free, no account):   npx wrangler d1 migrations apply DB --local
-- Apply to production (ASK FIRST per CLAUDE.md): npx wrangler d1 migrations apply DB --remote
CREATE TABLE refresh_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  records INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_refresh_log_source_created ON refresh_log (source_slug, created_at DESC);
