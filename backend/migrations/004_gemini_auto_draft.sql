-- 004_gemini_auto_draft.sql
-- Supports fully automated client drafting via the Gemini API (optional -
-- only used when GEMINI_API_KEY is set in the backend's environment/.env).
-- auto_drafted distinguishes a machine-produced draft from one Akash
-- uploaded by hand via /deliver, so the admin UI and client portal can both
-- flag it clearly. auto_draft_error records why an attempted auto-draft
-- fell back to the manual queue (bad/missing key, Gemini outage, empty
-- extracted text, etc.) so Akash isn't left guessing why a request that
-- "should" have auto-drafted didn't.

ALTER TABLE draft_requests ADD COLUMN auto_drafted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE draft_requests ADD COLUMN auto_draft_error TEXT;
