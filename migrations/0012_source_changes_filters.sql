-- Change-feed filters (trademark-watch-surface, 2026-09-28). A watch is one
-- call — `/v1/changes/uk-trademark-journal?classes=09&q=northwind` — so the
-- feed takes the source's own query params with /v1/data semantics. The
-- search text and the JS-lowercased record copy that make those filters fold
-- identically ride along from source_records at diff time; rows written
-- before this migration are NULL here and fall back to lower(record).
ALTER TABLE source_changes ADD COLUMN search TEXT;
ALTER TABLE source_changes ADD COLUMN record_lc TEXT;
