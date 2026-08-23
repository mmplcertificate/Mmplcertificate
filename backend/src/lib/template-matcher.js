// Shared, conservative category-keyword template matcher.
// Used both by the admin-side "Draft with Claude" button and the client
// draft-request flow, so behavior stays identical between them.
//
// Deliberately conservative: earlier auto-attach experiments (folder/tender-no
// matching) produced false positives against the real 139-certificate dataset,
// so this only does category-keyword matching against past CERTIFICATE-stage
// records, plus a separate MRL-matching branch for the client flow.

// Keys here MUST match the certificate `category` values used throughout the
// app (see category_list in certificates_data.json / the certificate form),
// e.g. "Net Worth Certificate" - NOT a short form like "Net Worth". This used
// to be a short form, which meant findBestTemplate()'s exact-match check
// against real certificate.category values ("Net Worth Certificate", etc.)
// could never succeed - template matching silently found nothing for every
// category, even with a full set of correctly-categorized past certificates
// on file. Fixed 2026-08-23.
//
// "No CDR Certificate" is listed before "CDR Certificate" on purpose: text
// containing "no cdr" also contains the substring "cdr", so if the generic
// CDR check ran first it would misfire on "No CDR" text before the more
// specific check ever got a turn.
const CATEGORY_KEYWORDS = {
  'No CDR Certificate': ['no cdr'],
  'CDR Certificate': ['cdr', 'corporate debt restructuring'],
  'Net Worth Certificate': ['net worth', 'networth'],
  'Turnover Certificate': ['turnover'],
  'Local Content Certificate': ['local content', 'local value addition', 'lva'],
  'Shareholding Certificate': ['shareholding', 'shareholder'],
  'Working Capital Certificate': ['working capital'],
  'Solvency Certificate': ['solvency'],
  'Total Income Certificate': ['total income'],
  'Audit Under Process Certificate': ['audit under process', 'audit-under-process', 'under process'],
  MRL: ['mrl', 'manufacturer relationship letter', 'manufacturer authorization'],
};

function detectCategory(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return null;
}

/**
 * Finds the best-matching past certificate for a given category.
 * candidates: array of certificate rows (id, category, fy, particulars, updated_at, ...)
 * Returns the most recently updated certificate with an exact category match, or null.
 */
function findBestTemplate(candidates, category) {
  if (!category) return null;
  const matches = candidates.filter(
    (c) => (c.category || '').toLowerCase() === category.toLowerCase()
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return matches[0];
}

/**
 * Given free text (e.g. an NIT filename or pasted notes) and a list of past
 * certificates, detects the likely category and returns the best template match.
 * Never guesses across categories, and returns null rather than a low-confidence
 * guess — matching the conservative behavior validated against the real dataset.
 */
function matchFromText(text, candidates) {
  const category = detectCategory(text);
  const template = findBestTemplate(candidates, category);
  return { category, template };
}

module.exports = { CATEGORY_KEYWORDS, detectCategory, findBestTemplate, matchFromText };
