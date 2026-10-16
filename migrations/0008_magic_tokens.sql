-- Passwordless sign-in tokens (task 25 item 3). Moved from KV to D1 so
-- single-use is ATOMIC: consumption is one `UPDATE ... WHERE used_at IS NULL`
-- whose row-count decides the winner, closing the get-then-delete race two
-- concurrent verifies could otherwise both pass. Low volume (login is
-- rate-limited), short-lived rows, swept opportunistically on issue.
CREATE TABLE magic_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  -- epoch ms
  expires_at INTEGER NOT NULL,
  -- epoch ms of consumption; NULL until used
  used_at INTEGER
);

CREATE INDEX idx_magic_tokens_expires ON magic_tokens (expires_at);
