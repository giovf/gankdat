-- D1-backed DataSource storage (task 44): datasets too large for the KV
-- snapshot pattern (25MiB value cap, full JSON parse per request) keep their
-- records here. Refresh writes a new generation then flips source_meta, so
-- readers never see a partially-loaded dataset; old generations are deleted
-- after the flip.
CREATE TABLE source_records (
  source_slug TEXT NOT NULL,
  generation INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  -- Lowercased concatenation of the record's string fields, precomputed at
  -- ingest for the platform-reserved `q` substring search.
  search TEXT NOT NULL,
  -- The normalized record as JSON; filters use json_extract against it.
  record TEXT NOT NULL,
  PRIMARY KEY (source_slug, generation, seq)
);

CREATE TABLE source_meta (
  source_slug TEXT PRIMARY KEY,
  -- The generation queries read; flipped atomically after a full load.
  generation INTEGER NOT NULL,
  last_refreshed_at TEXT NOT NULL,
  total INTEGER NOT NULL
);
