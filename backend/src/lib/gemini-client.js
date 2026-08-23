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

async function generate(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  // Auth via the 'X-goog-api-key' header, not a '?key=' query param - matches
  // AI Studio's own generated quickstart, and is the right way to send the
  // newer "auth key" format (keys created in AI Studio today, prefixed
  // "AQ." rather than the older "AIza..." API-key format).
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
      throw new Error(`Gemini API returned ${res.status}: ${body.slice(0, 300)}`);
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

module.exports = { generate, draftFromTemplate, DISCLAIMER, MODEL };
