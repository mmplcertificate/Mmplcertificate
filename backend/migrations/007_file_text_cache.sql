-- 007_file_text_cache.sql
-- Reference-certificate documents that are genuinely scanned (photocopier)
-- PDFs go through OCR (pdftoppm + tesseract), which can legitimately take
-- well over a minute per document - multiple times longer than any
-- per-request timeout we can afford to block a user-facing draft request on.
-- Every past auto-draft attempt re-runs that same slow OCR from scratch on
-- the same handful of frequently-reused reference certificates, so it times
-- out the same way every single time and those documents can never
-- contribute real reference text.
--
-- extracted_text caches the result of extractText() for a file_library row
-- permanently, keyed by file id, so OCR for any given document only ever
-- has to actually finish once (even if that one time runs in the
-- background well past the current request) - after that every future
-- request that reuses the same certificate as a reference gets the cached
-- text instantly, no OCR required.
ALTER TABLE file_library ADD COLUMN extracted_text TEXT;
ALTER TABLE file_library ADD COLUMN extracted_text_at TEXT;
