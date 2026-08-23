-- 002_financials.sql
-- Financial documents used to auto-suggest annexures by FY.

CREATE TABLE IF NOT EXISTS financial_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES file_library(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  fy TEXT, -- parsed Indian FY, e.g. "2022-23"
  as_of_date TEXT, -- parsed "as of" date where filename encodes one (e.g. 31.03.2024)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_financial_documents_fy ON financial_documents(fy);
