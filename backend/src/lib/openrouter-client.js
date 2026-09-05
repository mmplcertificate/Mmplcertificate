// Thin wrapper around OpenRouter's REST endpoint (no SDK dependency - Node's
// built-in fetch is enough, same philosophy as gemini-client.js). This is an
// ALTERNATIVE provider, selected via ai-provider.js when AI_PROVIDER=openrouter
// is set - it is not used unless that env var picks it. Every caller must
// still treat a thrown error as "fall back to the manual queue", never as
// "block the request" - same contract as gemini-client.js.
//
// Deliberately kept as a self-contained duplicate of gemini-client.js's
// prompt-building/parsing logic (KNOWN_CATEGORIES, DISCLAIMER, the tuned
// Net Worth / financial-eligibility prompt guidance, parseRequirementsJson)
// rather than a shared module, so switching providers can never accidentally
// change or break the already-verified Gemini path. If the prompt is tuned
// further after real-world testing (the same way the Net Worth clause fix
// happened for Gemini), update both files.
//
// Free-tier model choice, revised 2026-09-02 after live testing against a
// real tender document (Tendernotice_1.pdf, ~271k characters):
//   - nvidia/nemotron-3.5-lightning:free (1M context): ran without errors
//     but found 0 of the 5 real certificate requirements a plain keyword
//     search of the same document turned up. Too unreliable for this task.
//   - thinkingmachines/inkling:free (1M context): rejected outright by
//     OpenRouter with 403 "only available on agentic harnesses" - not
//     usable from a plain server-side API call at all.
//   - inclusionai/ling-3.0-flash-fin:free (262k context, finance-tuned):
//     found all 5 real requirements (Turnover, Working Capital, Net Worth,
//     No CDR, Local Content), with correctly-quoted figures and sound
//     reasoning, in 39.5s. Chosen as the default on that basis. 262k
//     tokens (~1M characters) still comfortably covers the ~225k-token
//     worst case that ruled out Gemini's and Groq's free tiers - see the
//     project status doc's 2026-09-01/02 sessions for the full comparison.
const MODEL = process.env.OPENROUTER_MODEL || 'inclusionai/ling-3.0-flash-fin:free';
// Free-tier OpenRouter models can take noticeably longer than Gemini's
// dedicated infra to chew through a large tender document (seen: aborting
// at 60s on a ~270k-character document during real-world testing on
// 2026-09-02), so this is set higher than gemini-client.js's TIMEOUT_MS.
const TIMEOUT_MS = 180000;
// OpenRouter's own docs call out 429 (rate limited) as retry-worthy; 503-class
// upstream-provider errors are also worth a short retry, same reasoning as
// gemini-client.js's RETRYABLE_STATUSES.
const RETRYABLE_STATUSES = new Set([429, 502, 503]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generate(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await generateOnce(prompt, apiKey);
    } catch (e) {
      lastError = e;
      if (e.retryableStatus && attempt < MAX_ATTEMPTS) {
        console.error(`OpenRouter API attempt ${attempt}/${MAX_ATTEMPTS} failed (${e.message}) - retrying in ${RETRY_DELAY_MS}ms`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

// OpenRouter's API is OpenAI-compatible chat completions - Bearer auth,
// POST /api/v1/chat/completions, response text at
// data.choices[0].message.content. HTTP-Referer/X-Title headers are
// OpenRouter's own recommended (not required) attribution headers, shown on
// their own docs and in their dashboard's usage view - harmless to include.
async function generateOnce(prompt, apiKey) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://mmplcertificate.onrender.com',
        'X-Title': 'MMPL Certificates & Billing',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        // Some free "reasoning" models spend part of this budget on hidden
        // chain-of-thought before writing the actual answer, and a small
        // cap can burn out entirely on reasoning for a large document -
        // seen as a fully empty response on a ~459k-character tender during
        // real-world testing on 2026-09-02 (max_tokens was 4096 then).
        // Raised well above what the JSON answer itself could ever need.
        max_tokens: 16000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenRouter API returned ${res.status}: ${body.slice(0, 300)}`);
      if (RETRYABLE_STATUSES.has(res.status)) err.retryableStatus = res.status;
      throw err;
    }

    const data = await res.json();
    // A free model can also come back with an explicit error object inside
    // a 200 response (OpenRouter's documented behavior for some upstream
    // provider failures) - treat that the same as a thrown HTTP error.
    if (data?.error) {
      throw new Error(`OpenRouter API error: ${JSON.stringify(data.error).slice(0, 300)}`);
    }
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text.trim()) {
      // Include finish_reason (e.g. "length" means it ran out of the
      // max_tokens budget, most likely to hidden reasoning tokens on a
      // free "thinking" model) so an empty response is diagnosable instead
      // of a bare "empty response" with no clue why.
      const choice = data?.choices?.[0];
      const detail = choice
        ? `finish_reason=${choice.finish_reason || 'unknown'}, native_finish_reason=${choice.native_finish_reason || 'unknown'}`
        : 'no choice object in response';
      throw new Error(`OpenRouter API returned an empty response (${detail})`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

const { financialFiguresPromptBlock } = require('./financial-figures');
const { resolvePartner, resolveLocation } = require('./signing-partners');

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
 * catch and fall back to the manual review queue). Mirrors
 * gemini-client.js#draftFromTemplate exactly.
 */
async function draftFromTemplate({ category, requestType, templateText, nitText, notes, certMeta, signingPartner, certificateLocation }) {
  // Resolved from a dropdown value in the request form (added 2026-09-05) -
  // see lib/signing-partners.js. Never trusts free text for the partner's
  // membership number/firm details; falls back to the one real partner
  // and location on file if the value is missing or unrecognized.
  const partner = resolvePartner(signingPartner);
  const location = resolveLocation(certificateLocation);
  const parts = [
    `You are drafting a ${category || requestType.toUpperCase()} document for MMPL Private Limited, in the style and structure of Singhi & Co.'s past certificates.`,
    // Fixed fact regardless of template availability: Singhi & Co. is always
    // the certifying Chartered Accountant firm, MMPL Private Limited is
    // always the client being certified for. Found 2026-09-05: without this,
    // a template-less draft (no extractable text - e.g. a scanned template
    // with no OCR available on Render) confused the two, signing off "For
    // and on behalf of MMPL Private Limited" instead of "For Singhi & Co.,
    // Chartered Accountants".
    'Fixed facts, true regardless of what the template/tender documents say: the certifying Chartered Accountant firm is always "Singhi & Co., Chartered Accountants" (Firm Registration No. 302049E) - the certificate is always signed off in that firm\'s name (e.g. "For Singhi & Co., Chartered Accountants"), never "for and on behalf of MMPL Private Limited" or any other client-side signature block. MMPL Private Limited is the client being certified for, not the certifying party.',
    // Fixed fact found 2026-09-05 by diffing AI drafts against a real signed
    // certificate: every draft addressed the tender-issuing authority
    // instead of the client, the reverse of this firm's real convention.
    'Fixed fact: this certificate is always addressed "To, The Board of Directors, M/s MMPL Private Limited" (the firm\'s own client) - never addressed to the tender-issuing authority (e.g. a corporation\'s General Manager, Chairman, or Deputy General Manager), even if the tender document names a specific officer to submit paperwork to. MMPL, as the client, is the one who submits the certificate onward to the tender authority after receiving it - the certificate itself is never addressed to that authority.',
    'Fixed fact: M/s MMPL Private Limited (Formerly known as Maheshwari Mining Private Limited) has its Registered Office at Shilpangan, Block-LB, Plot-1, Sector-III, Module-1, 4th Floor, CF Building, Salt Lake, Kolkata \u2013 700106 - use this exact registered-office address wherever the certificate names the Company\'s address, regardless of where the tender, mine, or site itself is located.',
    `Fixed fact: this certificate is always signed off "For ${partner.firmName}, Chartered Accountants, Firm Registration No. ${partner.firmRegistrationNo}" by "${partner.label}, ${partner.designation}, Membership No.: ${partner.membershipNo}" - use this exact name, designation, and membership number every time, never a different partner and never an unnamed signatory. The signature block always ends "Place: ${location}" followed by a "Date:" line. Between the firm registration line and the partner's printed name, leave one blank line with nothing on it (no "[Signature]" placeholder, no other text) - that gap is where the physical signature and firm stamp go once printed, exactly like a certificate ready to be signed.`,
    'Fixed fact: every certificate includes at least one Annexure (starting "Annexure - A") immediately after the main signature block, ending with the same "For Singhi & Co." signature block repeated at the end of the Annexure. The Annexure contains the actual supporting computation for the certified figure - normally a numbered table (e.g. SL No. / Particulars / Value in Rs. Lakhs) showing how the figure was built up from the underlying financial figures, at the same level of detail as Singhi & Co.\'s real certificates for this category. Never state a certified figure in the main body without also breaking it down in an Annexure.',
    'Fixed fact: the main body is always written as numbered paragraphs (1., 2., 3., ...) under these exact section headings, in this order, every time, even when a tender document is not available to fill in every detail: an opening unnumbered paragraph identifying the Company and its registered office, then a numbered paragraph 1 stating who engaged Singhi & Co. and for what purpose; a "Management\'s Responsibility" heading with its paragraph(s); an "Auditors\' Responsibility" heading with its paragraph(s) (including a paragraph on compliance with the ICAI Guidance Note on Reports or Certificates for Special Purposes and Standard on Quality Control (SQC) 1); a "Conclusion" heading with the certified figure; and a "Restriction on Use" heading limiting the certificate to the stated purpose. This is not optional shorthand for when tender specifics are missing - write the full structure regardless, using "[VERIFY: <what is needed>]" in place of any missing tender number, clause reference, or engagement letter date rather than shortening or skipping a section.',
    templateText
      ? `Reference template (past certificate to match wording/structure/format against):\n---\n${templateText.slice(0, 12000)}\n---`
      : 'No past template text was available to extract automatically — draft using standard Singhi & Co. certificate conventions for this category, and mark this fact clearly.',
    nitText
      ? `New tender/engagement document (source for the specific figures, party names, and dates to use):\n---\n${nitText.slice(0, 12000)}\n---`
      : 'No tender document text could be extracted automatically — use the notes below and leave figure placeholders as [VERIFY].',
    // Real Net Worth / Turnover / Working Capital figures from the client's
    // own signed audited financials, added 2026-09-05 - see
    // lib/financial-figures.js and lib/financial-figures.json.
    // Returns null (and this line is dropped by the .filter(Boolean) below)
    // if that data file is ever missing, so this can never block a draft.
    financialFiguresPromptBlock(),
    notes ? `Additional notes from the client: ${notes}` : '',
    certMeta ? `Closest past reference certificate on file: #${certMeta.id} — ${certMeta.particulars || ''} (FY ${certMeta.fy || 'n/a'}, tender no. ${certMeta.tender_no || 'n/a'}).` : '',
    'Instructions: match the past certificate\'s exact wording and structure as closely as possible, including its numbered paragraph structure (typically an opening engagement paragraph, then Management\'s Responsibility, Auditors\' Responsibility, Conclusion, and Restriction on Use sections) and its Annexure. Where no template is available, reproduce Singhi & Co.\'s standard certificate structure and the fixed facts above rather than inventing a different format. Substitute the new party names, dates, and figures from the tender document, using the confirmed financial figures above wherever they apply. Where a figure cannot be determined from the supplied documents or the confirmed figures, write "[VERIFY: <what is needed>]" rather than guessing. Do not fabricate UDIN, signing dates, or amounts. Output only the drafted document text, no commentary.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const draft = await generate(parts);
  return DISCLAIMER + draft;
}

// Must match gemini-client.js's KNOWN_CATEGORIES exactly - both feed the
// same certificates.category column and the same downstream template
// matcher (lib/template-matcher.js).
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
 * and/or MRL the tender requires the bidder's STATUTORY AUDITOR to issue.
 * Mirrors gemini-client.js#analyzeTenderDocument exactly, including the
 * Net Worth / financial-eligibility prompt guidance found necessary during
 * real-world testing on the HCL tender (see gemini-client.js's comments
 * for the full history of that fix).
 */
async function analyzeTenderDocument({ text }) {
  const prompt = [
    "You are a statutory-audit compliance assistant for an Indian Chartered Accountant firm (Singhi & Co.), reviewing a tender/bid document (NIT) on behalf of a bidding company (MMPL Private Limited).",
    'The tender document text below includes "[PAGE n]" markers showing where each page starts - use the nearest preceding marker as the page reference for anything you cite.',
    "Identify every certificate and/or MRL (Manufacturer's Relationship Letter / manufacturer authorization letter) that this tender explicitly requires to be issued or signed by the bidder's STATUTORY AUDITOR / Chartered Accountant - not documents required from any other party (bank, government authority, manufacturer, etc.) unless it is specifically an MRL requirement.",
    `For each one found, use exactly one of these category names if it matches (do not invent variants or abbreviate): ${KNOWN_CATEGORIES.join(', ')}, or "MRL". If a requirement doesn't cleanly match any of these, use "Other Certificate" and explain what it actually is in the reasoning field.`,
    `Eligibility criteria for financial standing (net worth, annual turnover, working capital, solvency) or corporate status (shareholding pattern, local content percentage, CDR/insolvency status) often state the requirement and ask for supporting audited-financial evidence WITHOUT the word "certificate" appearing in that specific sentence. Treat these the same as an explicit certificate requirement whenever the criterion matches one of these category names: Net Worth Certificate, Turnover Certificate, Working Capital Certificate, Solvency Certificate, Shareholding Certificate, Local Content Certificate, CDR Certificate, No CDR Certificate, CDR / IBC Certificate - in this firm's actual practice, that kind of financial/corporate eligibility criterion is always evidenced with a certificate from the statutory auditor, even when the tender just says "documentary evidence" or "audited financial statement". Do NOT extend this leniency to criteria outside those categories (technical experience, physical infrastructure, litigation history, EMD/bank guarantee, insurance, etc.) - for those, still require the clause to explicitly name a certificate/CA/statutory auditor before including it.`,
    `A tender's financial-eligibility section sometimes also requires a declaration that the bidder's financial statements/results are still under audit as of the tender opening or bid submission date (a fallback used when a CA certificate confirming the latest year's turnover/net worth isn't yet available) - use category "Audit Under Process Certificate" for this. Flag it even when the tender's own wording attributes the declaration to "the bidder", "CEO/CFO", or another company officer rather than explicitly to the CA/statutory auditor: in this firm's actual practice, this is always issued as a statutory-auditor certificate regardless of which party the tender names, the same way the categories in the previous paragraph are handled.`,
    'Respond with ONLY a JSON array (no markdown code fences, no commentary before or after) of objects with this exact shape:\n[{"category": "Net Worth Certificate", "page_reference": "Page 4", "quote": "the exact short clause from the document, max ~200 characters", "reasoning": "one sentence on why this certificate is required"}]',
    'If the document does not clearly require any statutory-auditor certificate or MRL, respond with an empty JSON array: []. Do not guess or include anything that is not clearly stated as required - a false positive is worse than a miss here, since a human reviews this list before anything is drafted.',
    `Tender document text:\n---\n${text.slice(0, 900000)}\n---`,
  ].join('\n\n');

  const raw = await generate(prompt);
  return parseRequirementsJson(raw);
}

// Finds the first *complete* top-level JSON array in text by tracking
// bracket depth (ignoring brackets that appear inside quoted strings)
// rather than a greedy regex from the first "[" to the last "]" in the
// whole response. Needed because this free model sometimes adds trailing
// commentary after the array despite being told not to (seen during
// real-world testing on 2026-09-02) - a greedy regex would swallow any
// stray bracket in that trailing text and produce invalid JSON.
function extractFirstJsonArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseRequirementsJson(raw) {
  // Some free models wrap JSON in ```json ... ``` fences despite being told
  // not to - strip those before parsing, same handling as gemini-client.js.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    const extracted = extractFirstJsonArray(cleaned);
    if (!extracted) {
      throw new Error(`OpenRouter analysis response was not valid JSON: ${cleaned.slice(0, 300)}`);
    }
    try {
      parsed = JSON.parse(extracted);
    } catch (e2) {
      throw new Error(`OpenRouter analysis response contained an array but it wasn't valid JSON (${e2.message}): ${extracted.slice(0, 300)}`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error('OpenRouter analysis response was not a JSON array');
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
