-- D1 filter case-fold parity (task 25 item 10). SQLite lower() only folds
-- ASCII, so per-field substring filters under-matched accented names relative
-- to the KV path's JS toLowerCase (e.g. "josé" not matching "JOSÉ"). We now
-- store a JS-lowercased copy of each record and match against it, so both
-- storage kinds fold identically. Nullable + a COALESCE fallback in the query
-- means rows written before the next refresh keep working (ASCII behaviour)
-- until the generation is replaced.
ALTER TABLE source_records ADD COLUMN record_lc TEXT;
