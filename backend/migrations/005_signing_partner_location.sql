-- 005_signing_partner_location.sql
-- Adds explicit signing-partner and certificate-location selection to a
-- draft request, instead of only ever hardcoding "Sankar Bandyopadhyay" /
-- "Kolkata" inside the AI prompt (lib/signing-partners.js). Both columns
-- are nullable free-text: the frontend only ever sends a value from a
-- known dropdown (see lib/signing-partners.js's PARTNERS/LOCATIONS lists),
-- and draftFromTemplate() falls back to the default partner/location if
-- either is missing/unrecognized, so old rows (NULL here) and any caller
-- that doesn't send these fields keep working exactly as before.

ALTER TABLE draft_requests ADD COLUMN signing_partner TEXT;
ALTER TABLE draft_requests ADD COLUMN certificate_location TEXT;
