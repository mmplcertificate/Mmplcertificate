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
// Blank/master templates (four on file, one per starter category - see
// migrate_real_data.py) are placeholder forms with no real filled-in
// figures or, in some categories, no real Annexure content at all - they
// exist so a category always has *something* to fall back on, never as a
// stand-in for an actual issued certificate. Found 2026-09-06: because
// several of them tied on updated_at with everything else, they kept
// winning "most recent match" and "closest real example" alike, feeding
// the AI drafter a structure-less placeholder instead of a real signed
// certificate to learn this category's actual pattern from. Excluded from
// template matching generically (by how these four rows are labeled, not
// by category) rather than special-cased per category.
const BLANK_TEMPLATE_PATTERN = /^master blank template/i;

function isRealCertificate(c) {
  return !BLANK_TEMPLATE_PATTERN.test(c.particulars || '');
}

function findBestTemplate(candidates, category) {
  if (!category) return null;
  const matches = candidates.filter(
    (c) => (c.category || '').toLowerCase() === category.toLowerCase() && isRealCertificate(c)
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return matches[0];
}

/**
 * Up to `limit` recent real (non-blank-template) past certificates in the
 * given category, most-recently-updated first - used to give the AI
 * drafter several genuine examples to learn this category's pattern from
 * instead of a single template or a hardcoded per-category rule.
 */
function findRecentRealCertificates(candidates, category, limit) {
  if (!category) return [];
  const matches = candidates.filter(
    (c) => (c.category || '').toLowerCase() === category.toLowerCase() && isRealCertificate(c)
  );
  matches.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return matches.slice(0, limit);
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

// --- Engagement-level matching (added 2026-09-06) -------------------------
// A single real tender usually needs SEVERAL certificate categories at once
// (e.g. one tender_no on file has Net Worth + Turnover + Audit Under Process
// all issued together) - real certificates on file that share a tender_no
// are one coherent, real-world example of how this firm handled a similar
// engagement, richer than picking same-category certificates from unrelated
// tenders. Grouping is done here from the real tender_no data already on
// file; deciding WHICH past tender is actually similar to a new one is left
// to the AI (see matchSimilarEngagement in gemini-client.js/
// openrouter-client.js) rather than any keyword rule here.

/**
 * Groups real (non-blank-template) certificates that have a tender_no on
 * file into one entry per distinct tender_no, each listing which categories
 * were issued for it and a short description - the candidate list an AI
 * call can pick the closest match from.
 */
function buildPastEngagements(candidates) {
  const byTender = new Map();
  for (const c of candidates) {
    if (!isRealCertificate(c)) continue;
    const tenderNo = (c.tender_no || '').trim();
    if (!tenderNo) continue;
    if (!byTender.has(tenderNo)) byTender.set(tenderNo, []);
    byTender.get(tenderNo).push(c);
  }
  return Array.from(byTender.entries()).map(([tenderNo, certs]) => ({
    tenderNo,
    categories: Array.from(new Set(certs.map((c) => c.category).filter(Boolean))),
    particulars: certs.map((c) => c.particulars).find(Boolean) || null,
  }));
}

/**
 * All real certificates on file (any category) that share the given
 * tender_no, most-recently-updated first, capped to `limit` - the full set
 * of certificates issued for one matched past engagement.
 */
function findCertificatesByTenderNo(candidates, tenderNo, limit) {
  if (!tenderNo) return [];
  const matches = candidates.filter(
    (c) => isRealCertificate(c) && (c.tender_no || '').trim() === tenderNo
  );
  matches.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return matches.slice(0, limit);
}

module.exports = {
  CATEGORY_KEYWORDS,
  detectCategory,
  findBestTemplate,
  findRecentRealCertificates,
  isRealCertificate,
  matchFromText,
  buildPastEngagements,
  findCertificatesByTenderNo,
};
