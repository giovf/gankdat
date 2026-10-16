-- Lazy OAuth for the MCP server (build routine 2026-09-30). Claude, Cursor and
-- ChatGPT start sign-in only on an HTTP 401 with a WWW-Authenticate challenge,
-- so the server is now its own small authorization server (CIMD + PKCE, public
-- clients, refresh rotation). One table holds every OAuth artefact, told apart
-- by `kind`:
--   request  — a pending /authorize request (the consent page is rendered from
--              it, possibly in another tab after the magic-link hop);
--   code     — an authorization code (5 min, single use);
--   access   — a bearer access token (1 h) mapped to an API key on the account,
--              so plan, credits and metering apply exactly as for the key;
--   refresh  — a refresh token (30 d, rotated on use; a replay revokes the family).
-- Only SHA-256 hashes of the secrets are stored. `family` ties a code and every
-- token derived from it to one connection; `used_at` is the single-use marker
-- (atomic UPDATE ... WHERE used_at IS NULL) and, for access tokens, revocation.
CREATE TABLE oauth_grants (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  family TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT,
  scope TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT,
  resource TEXT,
  account_id TEXT,
  key_id TEXT,
  -- epoch ms
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX idx_oauth_grants_family ON oauth_grants (family);
CREATE INDEX idx_oauth_grants_expires ON oauth_grants (expires_at);
