-- RFC 7591 dynamic client registration (burn-down 2026-10-10, queue
-- oauth-dynamic-client-registration). Docker's MCP Toolkit, Cursor, ChatGPT and
-- VS Code register an OAuth client by POSTing their metadata to /register; only
-- Claude carries a client-id metadata document, so until now the 2026-09-30
-- OAuth hop worked for Claude alone. One row per registered public client:
-- the random client_id (`gkcl_<label>_<hex>`, the label being the display host
-- derived from the first https redirect_uri or the client_name), the
-- self-asserted name, and the redirect URIs /authorize will accept exactly as
-- it does a CIMD document's. No secret is issued (token_endpoint_auth_method
-- none, PKCE). Nothing personal is stored. Rows with no grant for 90 days are
-- swept with the expired grants.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  -- JSON array of strings
  redirect_uris TEXT NOT NULL,
  -- epoch ms
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_oauth_clients_created ON oauth_clients (created_at);
