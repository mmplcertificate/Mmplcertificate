// Shared, conservative category-keyword template matcher.
// Used both by the admin-side "Draft with Claude" button and the client
// draft-request flow, so behavior stays identical between them.
//
// Deliberately conservative: earlier auto-attach experiments (folder/tender-no
// matching) produced false positives against the real 139-certificate dataset,
// so this only does category-keyword matching against past CERTIFICATE-stage
// records, plus a separate MRL-matching branch for the client flow.

const CATEGORY_KEYWORDS = {
  'Net Worth': ['net worth', 'networth'],
  Turnover: ['turnover'],
  'Local Content': ['local content', 'local value addition', 'lva'],
  CDR: ['cdr', 'corporate debt restructuring'],
  'No CDR': ['no cdr'],
  Shareholding: ['shareholding', 'shareholder'],
  'Working Capital': ['working capital'],
  Solvency: ['solvency'],
  'Total Income': ['total income'],
  'Audit-Under-Process': ['audit under process', 'audit-under-process', 'under process'],
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
