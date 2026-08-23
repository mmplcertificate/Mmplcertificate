-- 003_roles_and_client_portal.sql
-- Multi-role access: role + permissions on users, client_visible on certificates,
-- and the draft_requests queue for the client self-service portal.

ALTER TABLE users ADD COLUMN permissions TEXT; -- JSON, team-only e.g. {"tracking":true,"billing":true}

ALTER TABLE certificates ADD COLUMN client_visible INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS draft_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_by_user_id INTEGER NOT NULL REFERENCES users(id),
  request_type TEXT NOT NULL, -- certificate | mrl
  category TEXT,
  notes TEXT,
  nit_file_id INTEGER REFERENCES file_library(id),
  matched_certificate_id INTEGER REFERENCES certificates(id), -- best-guess template match, no AI
  status TEXT NOT NULL DEFAULT 'pending', -- pending | in_review | delivered
  result_file_id INTEGER REFERENCES file_library(id),
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_draft_requests_status ON draft_requests(status);
CREATE INDEX IF NOT EXISTS idx_draft_requests_user ON draft_requests(submitted_by_user_id);
