-- 001_init.sql
-- Core schema: certificates, certificate_documents, engagements, engagement_files,
-- file_library (content-addressed, dedup'd by sha256), users, audit_log.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- admin | team | client
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stage TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | pending_billing | billed
  category TEXT,
  client TEXT,
  owner TEXT, -- preparer: AK / SJ / Harshit Jain / Other
  tender_no TEXT,
  fy TEXT,
  particulars TEXT,
  document_date TEXT,
  signing_date TEXT,
  target_date TEXT,
  amount REAL,
  udin TEXT,
  bill_no TEXT,
  bill_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_certificates_stage ON certificates(stage);
CREATE INDEX IF NOT EXISTS idx_certificates_owner ON certificates(owner);
CREATE INDEX IF NOT EXISTS idx_certificates_fy ON certificates(fy);
CREATE INDEX IF NOT EXISTS idx_certificates_category ON certificates(category);

CREATE TABLE IF NOT EXISTS file_library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256 TEXT NOT NULL UNIQUE,
  storage_key TEXT NOT NULL, -- local relative path or S3 key
  original_name TEXT NOT NULL,
  size_bytes INTEGER,
  mime_type TEXT,
  source_path TEXT, -- original folder path at import time, for reference
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS certificate_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES file_library(id) ON DELETE CASCADE,
  doc_type TEXT, -- e.g. certificate, working paper, correspondence
  display_name TEXT,
  client_visible INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(certificate_id, file_id)
);

CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_name TEXT NOT NULL,
  folder_path TEXT NOT NULL,
  engagement_date TEXT, -- parsed from folder name where possible
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS engagement_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  engagement_id INTEGER NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  file_id INTEGER REFERENCES file_library(id) ON DELETE SET NULL,
  relative_path TEXT NOT NULL,
  embedded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Bootstrap certificate stage sanity check constraint via trigger (SQLite lacks CHECK-on-update in some versions)
