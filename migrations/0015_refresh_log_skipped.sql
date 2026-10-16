-- refresh_log gains the status 'skipped' (refresh-uk-trademark-journal, build 2026-10-07): a
-- refresh that did bounded preparatory work and deliberately left the data as it was — the
-- resumable hash backfill of a generation loaded before 0014 (d1store backfillHashes), which
-- hands the delta pass to the next night when its budget runs out. Neither 'ok' (the data
-- would read fresh) nor 'error' (nothing failed) says that. SQLite cannot alter a CHECK
-- constraint, so the table is rebuilt in place; the id sequence and the index are kept.
CREATE TABLE refresh_log_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'skipped')),
  records INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO refresh_log_v2 (id, source_slug, status, records, duration_ms, message, created_at)
  SELECT id, source_slug, status, records, duration_ms, message, created_at FROM refresh_log;
DROP TABLE refresh_log;
ALTER TABLE refresh_log_v2 RENAME TO refresh_log;
CREATE INDEX idx_refresh_log_source_created ON refresh_log (source_slug, created_at DESC);
