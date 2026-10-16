-- Change feeds (task 51). Each D1 refresh compares the new generation with the
-- previous one by the source's stable record id and records what was added,
-- removed or changed, so customers can poll "what changed since <date>"
-- instead of re-downloading whole registers — the gap every competitor leaves.
ALTER TABLE source_records ADD COLUMN record_id TEXT;
CREATE INDEX idx_source_records_id ON source_records (source_slug, generation, record_id);

CREATE TABLE source_changes (
  source_slug TEXT NOT NULL,
  -- ISO timestamp of the refresh that observed the change (one value per refresh).
  changed_at TEXT NOT NULL,
  -- 'added' | 'removed' | 'changed'
  change TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The record as of this refresh ('removed': the last version seen).
  record TEXT NOT NULL,
  PRIMARY KEY (source_slug, changed_at, change, record_id)
);
CREATE INDEX idx_source_changes_slug_time ON source_changes (source_slug, changed_at);
