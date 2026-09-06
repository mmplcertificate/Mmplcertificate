// Thin wrapper around the Gemini API's REST endpoint (no SDK dependency -
// Node 20's built-in fetch is enough). Used only when GEMINI_API_KEY is set;
// every caller must treat a thrown error as "fall back to the manual queue",
// never as "block the request" - a Gemini outage or a bad key should never
// stop a client from being able to submit a draft request.
// 'gemini-flash-latest' is the alias Google's own AI Studio quickstart
// recommends - it tracks their current stable Flash model automatically,
// so this doesn't need to be updated by hand as new models ship.
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
// 30s was sized for short drafting prompts (a template + one NIT, each
// capped at 12k chars). analyzeTenderDocument can now send up to ~900k
// characters of a real multi-hundred-page tender, which takes longer for
// the model to read - 60s gives that room without changing the fast path
// for the smaller drafting calls.
const TIMEOUT_MS = 60000;
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
 * catch and fall back to the manual review queue).
 */
async function draftFromTemplate({ category, requestType, referenceTemplates, nitText, notes, certMeta, signingPartner, certificateLocation }) {
  // Resolved from a dropdown value in the request form (added 2026-09-05) -
  // see lib/signing-partners.js. Never trusts free text for the partner's
  // membership number/firm details; falls back to the one real partner
  // and location on file if the value is missing or unrecognized.
  const partner = resolvePartner(signingPartner);
  const location = resolveLocation(certificateLocation);
  const financialBlock = financialFiguresPromptBlock();
  // Built from multiple real past certificates in this same category
  // (added 2026-09-06) rather than a single template, so the model can
  // compare them and infer the category's actual recurring pattern -
  // e.g. whether an Annexure applies at all and how many rows/years a
  // computation table shows - instead of that pattern being written here
  // as a per-category rule.
  const referenceBlock = referenceTemplates && referenceTemplates.length
    ? [
        `Reference certificates (${referenceTemplates.length} real, past certificate(s) Singhi & Co. has issued - some may be for a different certificate category than the one you are drafting now, when they come from the same or a similar past tender engagement as this one; study them together to identify the pattern each category actually follows before drafting, and rely only on the one(s) whose category matches "${category}" for that category's own subject matter and Annexure format):`,
        ...referenceTemplates.map(
          (t, i) => `--- Reference certificate ${i + 1} of ${referenceTemplates.length} (past certificate #${t.id}, category: ${t.category || category}, FY ${t.fy || 'n/a'}) ---\n${t.text.slice(0, 4000)}`
        ),
      ].join('\n\n')
    : null;
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
    'Fixed fact: whether this certificate includes an Annexure at all, and exactly what that Annexure computes (which columns, how many rows/years/components, whether a total or average row appears), is determined entirely by the reference certificate(s) below whose own category matches the one you are drafting now - not by any category name or rule stated here, and not by a reference certificate for a different category. Compare those same-category reference certificates to each other: if they consistently include a computation table, build one the same way, matching their exact structure (same columns, same number of rows/years/components, starting "Annexure - A" and ending with the same "For Singhi & Co." signature block repeated); if they consistently have no Annexure (e.g. they are a pure confirmation or negative-assurance statement), include none. Never invent an Annexure structure, or add/omit one, that the same-category reference certificates don\'t themselves show.',
    `Fixed fact: this certificate's actual subject matter is exactly what the reference certificate(s) below whose own category matches "${category}" certify - certify only that subject, in their own terms and wording. A reference certificate below for a different category (included only because it came from the same or a similar past tender engagement) shows you tone/context, never the subject matter to certify. Do not substitute a different, unrelated certification (for example, financial figures such as Net Worth, Turnover, or Working Capital) just because other data or other categories' reference certificates happen to be available in this prompt, unless the same-category reference certificates themselves include that data alongside their actual subject.`,
    'Fixed fact: the main body is always written as numbered paragraphs (1., 2., 3., ...) under these exact section headings, in this order, every time, even when a tender document is not available to fill in every detail: an opening unnumbered paragraph identifying the Company and its registered office, then a numbered paragraph 1 stating who engaged Singhi & Co. and for what purpose; a "Management\'s Responsibility" heading with its paragraph(s); an "Auditors\' Responsibility" heading with its paragraph(s) (including a paragraph on compliance with the ICAI Guidance Note on Reports or Certificates for Special Purposes and Standard on Quality Control (SQC) 1); a "Conclusion" heading with the certified figure; and a "Restriction on Use" heading limiting the certificate to the stated purpose. This is not optional shorthand for when tender specifics are missing - write the full structure regardless, using "[VERIFY: <what is needed>]" in place of any missing tender number, clause reference, or engagement letter date rather than shortening or skipping a section.',
    referenceBlock
      || 'No past certificate text was available to extract automatically for this category — draft using standard Singhi & Co. certificate conventions, and mark this fact clearly.',
    nitText
      ? `New tender/engagement document (source for the specific figures, party names, and dates to use):\n---\n${nitText.slice(0, 12000)}\n---`
      : 'No tender document text could be extracted automatically — use the notes below and leave figure placeholders as [VERIFY].',
    // Real Net Worth / Turnover / Working Capital figures from the client's
    // own signed audited financials, added 2026-09-05 - see
    // lib/financial-figures.js and lib/financial-figures.json.
    // Returns null (and this line is dropped by the .filter(Boolean) below)
    // if that data file is ever missing, so this can never block a draft.
    financialBlock
      ? `The following confirmed financial figures are provided for reference, but apply ONLY if this certificate's own category/subject is Net Worth, Turnover, Working Capital, or a category genuinely computed from them (e.g. Solvency). For any other certificate category (e.g. Local Content, No CDR, Shareholding, Total Income, AEO Registration), ignore these figures entirely and do not mention them anywhere in the draft:\n${financialBlock}`
      : null,
    notes ? `Additional notes from the client: ${notes}` : '',
    certMeta ? `Closest past reference certificate on file: #${certMeta.id} — ${certMeta.particulars || ''} (FY ${certMeta.fy || 'n/a'}, tender no. ${certMeta.tender_no || 'n/a'}).` : '',
    'Instructions: study the reference certificates above together (when provided) and identify the pattern they share for this category - wording, section structure, and Annexure format (or the lack of one) - then match that shared pattern as closely as possible rather than inventing a different format. Where no reference certificate is available, reproduce Singhi & Co.\'s standard certificate structure and the fixed facts above. Substitute the new party names, dates, and figures from the tender document, using the confirmed financial figures above only where they genuinely apply to this certificate\'s own subject matter (per the fixed facts above). Where a figure cannot be determined from the supplied documents, the confirmed figures, or the reference certificates, write "[VERIFY: <what is needed>]" rather than guessing. Do not fabricate UDIN, signing dates, or amounts. Output only the drafted document text, no commentary.',
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
    // A real gap found on the HCL tender above: its Net Worth clause says
    // "the Bidder shall have positive net worth as per their latest audited
    // financial statement... Relevant documentary evidence... shall be
    // furnished" - never using the word "certificate" - while neighboring
    // clauses in the same eligibility section do say "certificate from
    // Statutory Auditor". A strict "must say certificate" reading missed a
    // requirement any CA would recognize as needing a Net Worth Certificate.
    `Eligibility criteria for financial standing (net worth, annual turnover, working capital, solvency) or corporate status (shareholding pattern, local content percentage, CDR/insolvency status) often state the requirement and ask for supporting audited-financial evidence WITHOUT the word "certificate" appearing in that specific sentence. Treat these the same as an explicit certificate requirement whenever the criterion matches one of these category names: Net Worth Certificate, Turnover Certificate, Working Capital Certificate, Solvency Certificate, Shareholding Certificate, Local Content Certificate, CDR Certificate, No CDR Certificate, CDR / IBC Certificate - in this firm's actual practice, that kind of financial/corporate eligibility criterion is always evidenced with a certificate from the statutory auditor, even when the tender just says "documentary evidence" or "audited financial statement". Do NOT extend this leniency to criteria outside those categories (technical experience, physical infrastructure, litigation history, EMD/bank guarantee, insurance, etc.) - for those, still require the clause to explicitly name a certificate/CA/statutory auditor before including it.`,
    `A tender's financial-eligibility section sometimes also requires a declaration that the bidder's financial statements/results are still under audit as of the tender opening or bid submission date (a fallback used when a CA certificate confirming the latest year's turnover/net worth isn't yet available) - use category "Audit Under Process Certificate" for this. Flag it even when the tender's own wording attributes the declaration to "the bidder", "CEO/CFO", or another company officer rather than explicitly to the CA/statutory auditor: in this firm's actual practice, this is always issued as a statutory-auditor certificate regardless of which party the tender names, the same way the categories in the previous paragraph are handled.`,
    'Respond with ONLY a JSON array (no markdown code fences, no commentary before or after) of objects with this exact shape:\n[{"category": "Net Worth Certificate", "page_reference": "Page 4", "quote": "the exact short clause from the document, max ~200 characters", "reasoning": "one sentence on why this certificate is required"}]',
    'If the document does not clearly require any statutory-auditor certificate or MRL, respond with an empty JSON array: []. Do not guess or include anything that is not clearly stated as required - a false positive is worse than a miss here, since a human reviews this list before anything is drafted.',
    // Real NITs run to hundreds of pages, and the eligibility/qualification
    // clause that actually names the required certificates is often deep in
    // the document, not near the front (confirmed on a real 218-page/~527k-
    // character HCL tender: "Chartered Accountant"/"Statutory Auditor" first
    // appear around page 44, Shareholding around page 120, Working Capital
    // around page 206). A short slice here silently hides exactly the
    // clause this feature exists to find. gemini-flash-latest's context
    // window is ~1M tokens (~4M characters), so 900k characters (~225k
    // tokens) comfortably covers the largest real tenders seen so far while
    // still bounding cost/latency against a pathological upload.
    `Tender document text:\n---\n${text.slice(0, 900000)}\n---`,
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

/**
 * Asks the AI which past tender engagement (by tender_no) is most similar
 * in nature to a new tender's text, so that ALL the real certificates
 * issued for that one past tender - not just same-category ones from
 * unrelated engagements - can be used together as a coherent drafting
 * example. Returns null (never throws) if there's no NIT text, no past
 * engagements to compare against, or the response can't be parsed/doesn't
 * match a real tender_no - callers fall back to category-only matching in
 * every one of those cases, exactly like a missing template already does.
 */
async function matchSimilarEngagement({ nitText, pastEngagements }) {
  if (!nitText || !pastEngagements || pastEngagements.length === 0) return null;

  const listText = pastEngagements
    .slice(0, 60)
    .map((e, i) => `${i + 1}. Tender No.: ${e.tenderNo} | Certificates already issued for it: ${e.categories.join(', ') || 'n/a'} | ${e.particulars ? e.particulars.slice(0, 200) : ''}`)
    .join('\n');

  const prompt = [
    'You are helping a Chartered Accountant firm (Singhi & Co.) find which past tender engagement is most similar in nature to a brand new tender, so the certificates already issued for that similar past tender can be reused as real drafting examples for the new one.',
    `New tender document text:\n---\n${nitText.slice(0, 20000)}\n---`,
    `Past tender engagements this firm has already handled (numbered list - tender number | certificate categories already issued for it | a short description of that tender):\n${listText}`,
    'Identify which ONE past tender engagement (if any) is most similar to the new one - for example the same issuing authority/PSU, the same industry or type of site (mining, drilling, exploration, etc.), or the same kind of eligibility criteria - such that its past certificates would be a genuinely good structural and stylistic match for drafting certificates for the new tender. Only pick one if it is a reasonably close match - a wrong or forced match is worse than no match, since the caller falls back to a safe default when you say none are close.',
    'Respond with ONLY a JSON object (no markdown code fences, no commentary before or after): {"tender_no": "<the exact Tender No. value from the numbered list above that is the best match, or null if none are reasonably close>", "reasoning": "one short sentence"}',
  ].join('\n\n');

  let raw;
  try {
    raw = await generate(prompt);
  } catch (e) {
    return null;
  }

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : cleaned);
    if (!parsed || !parsed.tender_no || parsed.tender_no === 'null') return null;
    const found = pastEngagements.find((e) => e.tenderNo === parsed.tender_no);
    return found ? { tenderNo: found.tenderNo, reasoning: parsed.reasoning ? String(parsed.reasoning).trim() : null } : null;
  } catch (e) {
    return null;
  }
}

module.exports = { generate, draftFromTemplate, analyzeTenderDocument, matchSimilarEngagement, KNOWN_CATEGORIES, DISCLAIMER, MODEL };
