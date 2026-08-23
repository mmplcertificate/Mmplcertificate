// Thin wrapper around the Gemini API's REST endpoint (no SDK dependency -
// Node 20's built-in fetch is enough). Used only when GEMINI_API_KEY is set;
// every caller must treat a thrown error as "fall back to the manual queue",
// never as "block the request" - a Gemini outage or a bad key should never
// stop a client from being able to submit a draft request.
// 'gemini-flash-latest' is the alias Google's own AI Studio quickstart
// recommends - it tracks their current stable Flash model automatically,
// so this doesn't need to be updated by hand as new models ship.
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TIMEOUT_MS = 30000;
// 503 ("model overloaded, spikes are usually temporary" - Google's own
// wording) and 429 (rate limited) are the two statuses Google's docs call
// out as retry-worthy; a couple of short-backoff retries turns most of
// these transient blips into a success instead of a manual re-click.
// Anything else (400, 401/403, 404 bad model name, etc.) is not retried -
// retrying a bad request just wastes the retry budget on a guaranteed fail.
const RETRYABLE_STATUSES = new Set([503, 429]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generate(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await generateOnce(prompt, apiKey);
    } catch (e) {
      lastError = e;
      if (e.retryableStatus && attempt < MAX_ATTEMPTS) {
        console.error(`Gemini API attempt ${attempt}/${MAX_ATTEMPTS} failed (${e.message}) - retrying in ${RETRY_DELAY_MS}ms`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// Auth via the 'X-goog-api-key' header, not a '?key=' query param - matches
// AI Studio's own generated quickstart, and is the right way to send the
// newer "auth key" format (keys created in AI Studio today, prefixed
// "AQ." rather than the older "AIza..." API-key format).
async function generateOnce(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Gemini API returned ${res.status}: ${body.slice(0, 300)}`);
      if (RETRYABLE_STATUSES.has(res.status)) err.retryableStatus = res.status;
      throw err;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text.trim()) {
      throw new Error('Gemini API returned an empty response');
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

const DISCLAIMER = [
  '=== AI-GENERATED DRAFT — NOT A SIGNED OR CERTIFIED DOCUMENT ===',
  'This draft was produced automatically from a past template and the',
  'submitted tender documents, without review by Singhi & Co. Every figure,',
  'date, and statement must be independently verified against the audited',
  'financials and the engagement facts before this is used, signed, or',
  'relied upon in any way.',
  '================================================================',
  '',
].join('\n');

/**
 * Drafts a certificate/MRL from a past template's text plus the new NIT's
 * text. Returns the disclaimer-prefixed draft text, or throws (callers must
 * catch and fall back to the manual review queue).
 */
async function draftFromTemplate({ category, requestType, templateText, nitText, notes, certMeta }) {
  const parts = [
    `You are drafting a ${category || requestType.toUpperCase()} document for MMPL Private Limited, in the style and structure of Singhi & Co.'s past certificates.`,
    templateText
      ? `Reference template (past certificate to match wording/structure/format against):\n---\n${templateText.slice(0, 12000)}\n---`
      : 'No past template text was available to extract automatically — draft using standard Singhi & Co. certificate conventions for this category, and mark this fact clearly.',
    nitText
      ? `New tender/engagement document (source for the specific figures, party names, and dates to use):\n---\n${nitText.slice(0, 12000)}\n---`
      : 'No tender document text could be extracted automatically — use the notes below and leave figure placeholders as [VERIFY].',
    notes ? `Additional notes from the client: ${notes}` : '',
    certMeta ? `Closest past reference certificate on file: #${certMeta.id} — ${certMeta.particulars || ''} (FY ${certMeta.fy || 'n/a'}, tender no. ${certMeta.tender_no || 'n/a'}).` : '',
    'Instructions: match the past certificate\'s exact wording and structure as closely as possible. Substitute the new party names, dates, and figures from the tender document. Where a figure cannot be determined from the supplied documents, write "[VERIFY: <what is needed>]" rather than guessing. Do not fabricate UDIN, signing dates, or amounts. Output only the drafted document text, no commentary.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const draft = await generate(parts);
  return DISCLAIMER + draft;
}

// Canonical category names - must match certificates.category in the DB
// exactly (see lib/template-matcher.js's CATEGORY_KEYWORDS, which was fixed
// 2026-08-23 for this exact reason) so a requirement picked from this list
// downstream matches a real past certificate.
const KNOWN_CATEGORIES = [
  'Net Worth Certificate',
  'Turnover Certificate',
  'Local Content Certificate',
  'CDR Certificate',
  'No CDR Certificate',
  'Shareholding Certificate',
  'Working Capital Certificate',
  'Solvency Certificate',
  'Total Income Certificate',
  'Audit Under Process Certificate',
  'AEO Registration Certificate',
  'CDR / IBC Certificate',
  'Other Certificate',
];

/**
 * Reads a tender/NIT document's text (expects "[PAGE n]" markers from
 * document-text.js#extractTextWithPages) and identifies every certificate
 * and/or MRL the tender requires the bidder's STATUTORY AUDITOR to issue,
 * each with a page reference and a supporting quote. Powers the "scan a
 * tender document" upload flow - the caller reviews/picks from this list
 * before anything is actually drafted, so a missed or over-eager match here
 * is corrected by a human, not acted on blindly.
 *
 * Returns a parsed array (never throws on malformed model output without
 * first trying a couple of recovery strategies - see parseRequirementsJson).
 * Throwing here should always mean "show the error, fall back to the manual
 * form" to the caller, same convention as draftFromTemplate.
 */
async function analyzeTenderDocument({ text }) {
  const prompt = [
    "You are a statutory-audit compliance assistant for an Indian Chartered Accountant firm (Singhi & Co.), reviewing a tender/bid document (NIT) on behalf of a bidding company (MMPL Private Limited).",
    'The tender document text below includes "[PAGE n]" markers showing where each page starts - use the nearest preceding marker as the page reference for anything you cite.',
    "Identify every certificate and/or MRL (Manufacturer's Relationship Letter / manufacturer authorization letter) that this tender explicitly requires to be issued or signed by the bidder's STATUTORY AUDITOR / Chartered Accountant - not documents required from any other party (bank, government authority, manufacturer, etc.) unless it is specifically an MRL requirement.",
    `For each one found, use exactly one of these category names if it matches (do not invent variants or abbreviate): ${KNOWN_CATEGORIES.join(', ')}, or "MRL". If a requirement doesn't cleanly match any of these, use "Other Certificate" and explain what it actually is in the reasoning field.`,
    'Respond with ONLY a JSON array (no markdown code fences, no commentary before or after) of objects with this exact shape:\n[{"category": "Net Worth Certificate", "page_reference": "Page 4", "quote": "the exact short clause from the document, max ~200 characters", "reasoning": "one sentence on why this certificate is required"}]',
    'If the document does not clearly require any statutory-auditor certificate or MRL, respond with an empty JSON array: []. Do not guess or include anything that is not clearly stated as required - a false positive is worse than a miss here, since a human reviews this list before anything is drafted.',
    `Tender document text:\n---\n${text.slice(0, 40000)}\n---`,
  ].join('\n\n');

  const raw = await generate(prompt);
  return parseRequirementsJson(raw);
}

function parseRequirementsJson(raw) {
  // Gemini sometimes wraps JSON in ```json ... ``` fences despite being told
  // not to - strip those before parsing rather than failing on them.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    // Last resort: grab the first [...] block in the response, in case the
    // model added a stray sentence before/after the JSON despite the prompt.
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Gemini analysis response was not valid JSON: ${cleaned.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }
  if (!Array.isArray(parsed)) throw new Error('Gemini analysis response was not a JSON array');
  return parsed
    .filter((item) => item && typeof item === 'object' && item.category)
    .map((item) => ({
      category: String(item.category).trim(),
      page_reference: item.page_reference ? String(item.page_reference).trim() : null,
      quote: item.quote ? String(item.quote).trim() : null,
      reasoning: item.reasoning ? String(item.reasoning).trim() : null,
      is_mrl: /mrl/i.test(String(item.category)),
    }));
}

module.exports = { generate, draftFromTemplate, analyzeTenderDocument, KNOWN_CATEGORIES, DISCLAIMER, MODEL };
