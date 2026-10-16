-- Agent-side sign-up (build routine 2026-09-25). An AI agent at the paywall
-- hands over the user's email; the user approves ONE emailed link (a browser
-- click, same anti-prefetch GET-then-POST dance as magic links) and the agent
-- collects a key with the claim secret it was given. Only hashes of the claim
-- secret are stored; the raw key is minted at claim time and never persisted.
-- Rows: unapproved ones expire after 30 minutes, approved-but-unclaimed after
-- 24 h, claimed ones are kept 30 days (the "keys issued via the agent path"
-- proof number) and swept on the next request.
CREATE TABLE agent_signups (
  id TEXT PRIMARY KEY,
  -- hex SHA-256 of the claim secret the agent holds
  claim_hash TEXT NOT NULL UNIQUE,
  -- the emailed single-use approval token (256-bit random hex)
  approve_token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  -- short code shown to the user by the agent AND on the approval page
  code TEXT NOT NULL,
  client_name TEXT,
  -- epoch ms
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  claimed_at INTEGER,
  key_id TEXT
);

CREATE INDEX idx_agent_signups_expires ON agent_signups (expires_at);
