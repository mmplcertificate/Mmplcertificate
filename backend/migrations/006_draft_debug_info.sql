-- 006_draft_debug_info.sql
-- Adds a debug_info column (nullable JSON text) to draft_requests, populated
-- by attemptAutoDraft with a short diagnostic snapshot of how it built the
-- reference-certificate set for that draft: which sourcing path was used
-- (engagement match vs category fallback), the matched tender_no/reasoning
-- when applicable, and which reference certificates actually contributed
-- extractable text (id/category/text length) vs were skipped. This lets
-- Akash and Claude inspect why a given auto-draft came out the way it did
-- (e.g. missing an Annexure) directly from the request row via the admin
-- API, instead of having to dig through Render's log viewer. Purely
-- additive and nullable - old rows and any code path that never sets it
-- keep working exactly as before.

ALTER TABLE draft_requests ADD COLUMN debug_info TEXT;
