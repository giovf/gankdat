-- Feedback form (task 37): free-text product feedback from the website.
-- Multi-niche strategy: feedback replaces the Stage 0 pre-commit interview
-- as the demand-signal channel. Email is optional (only if the sender wants
-- a reply) — privacy policy documents this in the same commit.
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  email TEXT,
  page TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
