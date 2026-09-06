// Client request queue: client uploads an NIT -> system auto-finds the closest
// matching past template (same conservative matcher as draft-helper, no AI).
//
// Two modes, chosen automatically by whether GEMINI_API_KEY is set:
//  - Unset (default): request queues for Akash -> he drafts it in an actual
//    Claude conversation -> he uploads the finished result via /deliver ->
//    it appears in the client's portal. No third party ever sees the raw
//    documents.
//  - Set: the request is drafted automatically via Gemini (best-effort text
//    extraction from the matched template + the uploaded NIT) and delivered
//    to the client immediately, with no admin step - "auto_drafted" is set
//    so the admin/client UIs can flag it as machine-produced and unreviewed.
//    Any failure in this path (bad key, Gemini outage, nothing extractable)
//    falls back to the normal manual queue rather than blocking submission -
//    see auto_draft_error on the returned row for why, if it happened.
const express = require('express');
const multer = require('multer');
const db = require('../db');
const storage = require('../storage');
const { requireRole, requirePermission, logAudit } = require('../auth');
const { matchFromText, findRecentRealCertificates, buildPastEngagements, findCertificatesByTenderNo } = require('../lib/template-matcher');
const { extractText, extractTextWithPages } = require('../lib/document-text');
const { draftFromTemplate, analyzeTenderDocument, matchSimilarEngagement, isConfigured } = require('../lib/ai-provider');
const { notifyNewDraftRequest } = require('../lib/notify');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Reference-certificate extraction can hit OCR (see document-text.js) for a
// genuinely scanned past certificate, which is slow and, run back-to-back
// across several documents inside one request/response cycle, risks the
// kind of long-blocking behavior that can look like an unresponsive service
// on a resource-constrained host. Two guards keep this bounded:
//  - MAX_REFERENCE_CERTS caps how many past-certificate documents a single
//    auto-draft attempt will ever try to extract text from.
//  - withTimeout() caps how long any single document's extraction may run -
//    a document that blows the budget (most likely a multi-page OCR job) is
//    skipped (recorded in sourceCertSkipped) rather than left free to stall
//    the whole request.
const MAX_REFERENCE_CERTS = 5;
const REFERENCE_EXTRACT_TIMEOUT_MS = 25000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Shared by both POST '/' and POST '/analyze': clients always use these
// routes to reach Akash; admin/team can also use them directly (e.g. to
// scan/test a NIT without a separate client login). Team members need the
// 'drafting' permission (same one that gates the Client Requests tab).
function requireDraftingAccess(req, res, next) {
  if (req.user.role === 'team' && !(req.user.permissions && req.user.permissions.drafting)) {
    return res.status(403).json({ error: 'Missing permission: drafting' });
  }
  next();
}

// Uploads a tender/NIT file and asks Gemini which certificates and/or MRL
// it requires from the statutory auditor, with page references - the
// "scan a tender document" flow. This only reads and analyzes the file; it
// does not create any draft_requests rows itself. The caller reviews the
// returned requirements and picks which ones to actually submit via the
// normal POST '/' below, passing nit_file_id to reuse this same upload
// instead of re-uploading it once per selected certificate.
router.post('/analyze', requireRole('client', 'admin', 'team'), requireDraftingAccess, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  if (!isConfigured()) {
    return res.status(400).json({
      error: 'Tender scanning needs an AI provider configured (GEMINI_API_KEY or OPENROUTER_API_KEY, matching AI_PROVIDER), which is not set up yet. Use the manual request form below instead.',
    });
  }

  const sha256 = storage.sha256Buffer(req.file.buffer);
  const key = storage.keyForHash(sha256, req.file.originalname);
  await storage.putObject(key, req.file.buffer, req.file.mimetype);
  db.prepare(
    `INSERT INTO file_library (sha256, storage_key, original_name, size_bytes, mime_type)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sha256) DO NOTHING`
  ).run(sha256, key, req.file.originalname, req.file.buffer.length, req.file.mimetype);
  const fileRow = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(sha256);

  logAudit(req.user, 'draft_request.analyze', fileRow.id);

  let text = null;
  try {
    text = await extractTextWithPages(req.file.buffer, req.file.mimetype, req.file.originalname);
  } catch (e) {
    text = null;
  }

  if (!text || !text.trim()) {
    return res.json({
      nit_file_id: fileRow.id,
      filename: req.file.originalname,
      requirements: [],
      error:
        'Could not read any text from this file (unsupported format, or a scanned document with no readable text). You can still submit a request manually below.',
    });
  }

  try {
    const requirements = await analyzeTenderDocument({ text });
    res.json({ nit_file_id: fileRow.id, filename: req.file.originalname, requirements, error: null });
  } catch (e) {
    console.error('Tender analysis failed:', e.message);
    res.json({
      nit_file_id: fileRow.id,
      filename: req.file.originalname,
      requirements: [],
      error: `Automatic analysis failed (${e.message}). You can still submit a request manually below.`,
    });
  }
});

// Submit a new request (NIT upload + auto-template-match). Clients always
// use this to reach Akash; admin/team can also submit here themselves -
// e.g. to test how the matching/drafting pipeline behaves on a real NIT
// without needing a separate client login.
router.post(
  '/',
  requireRole('client', 'admin', 'team'),
  requireDraftingAccess,
  upload.single('nit'),
  async (req, res) => {
  const { request_type, category, notes, signing_partner, certificate_location } = req.body || {};
  if (!request_type) return res.status(400).json({ error: 'request_type is required' });

  let nitFileId = null;
  let nitFilenameForMatch = '';

  if (req.file) {
    const sha256 = storage.sha256Buffer(req.file.buffer);
    const key = storage.keyForHash(sha256, req.file.originalname);
    await storage.putObject(key, req.file.buffer, req.file.mimetype);
    const info = db
      .prepare(
        `INSERT INTO file_library (sha256, storage_key, original_name, size_bytes, mime_type)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO NOTHING`
      )
      .run(sha256, key, req.file.originalname, req.file.buffer.length, req.file.mimetype);
    const fileRow = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(sha256);
    nitFileId = fileRow.id;
    nitFilenameForMatch = req.file.originalname;
  } else if (req.body && req.body.nit_file_id) {
    // Reusing a file already uploaded via the '/analyze' tender-scan step -
    // e.g. several certificates picked off one scanned NIT each become
    // their own request without re-uploading the same file each time.
    const existing = db.prepare('SELECT * FROM file_library WHERE id = ?').get(req.body.nit_file_id);
    if (existing) {
      nitFileId = existing.id;
      nitFilenameForMatch = existing.original_name;
    }
  }

  const matchText = `${category || ''} ${notes || ''} ${nitFilenameForMatch}`;

  const candidates = db.prepare('SELECT * FROM certificates').all();
  const forcedCategory = request_type === 'mrl' ? 'MRL' : category;
  const { category: detectedCategory, template } = matchFromText(
    forcedCategory ? `${forcedCategory} ${matchText}` : matchText,
    candidates
  );

  const info = db
    .prepare(
      `INSERT INTO draft_requests (submitted_by_user_id, request_type, category, notes, nit_file_id, matched_certificate_id, signing_partner, certificate_location)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, request_type, category || null, notes || null, nitFileId, template ? template.id : null, signing_partner || null, certificate_location || null);

  logAudit(req.user, 'draft_request.create', info.lastInsertRowid);

  if (isConfigured()) {
    await attemptAutoDraft({
      requestId: info.lastInsertRowid,
      requestType: request_type,
      category: category || detectedCategory,
      notes,
      nitBuffer: req.file ? req.file.buffer : null,
      nitMimeType: req.file ? req.file.mimetype : null,
      nitFilename: req.file ? req.file.originalname : null,
      // Covers the "Prepare selected" tender-scan flow, which reuses an
      // already-uploaded NIT via nit_file_id instead of re-uploading it -
      // without this, nitBuffer is always null for that flow and auto-draft
      // silently has no NIT text to work with, however good the scan was.
      nitFileId,
      template,
      user: req.user,
      signingPartner: signing_partner,
      certificateLocation: certificate_location,
    });
  }

  const finalRow = db.prepare('SELECT * FROM draft_requests WHERE id = ?').get(info.lastInsertRowid);

  // Fire-and-forget: never await this, and notifyNewDraftRequest never
  // rejects - an email server being slow or down must never delay or break
  // the client's own request submission.
  notifyNewDraftRequest({
    id: finalRow.id,
    requestType: finalRow.request_type,
    category: finalRow.category,
    submittedBy: req.user.username,
    autoDrafted: !!finalRow.auto_drafted,
  });

    res.status(201).json(finalRow);
  }
);

// Attempts to draft the request automatically via Gemini and deliver it to
// the client right away. Any failure here is caught and recorded on the row
// as auto_draft_error - the request always stays usable via the normal
// manual /deliver flow even when this fails.
async function attemptAutoDraft({ requestId, requestType, category, notes, nitBuffer, nitMimeType, nitFilename, nitFileId, template, user, signingPartner, certificateLocation }) {
  let debugInfo = null; // populated below once available; persisted on both the success and failure paths
  try {
    let nitText = null;
    if (nitBuffer) {
      nitText = await extractText(nitBuffer, nitMimeType, nitFilename);
    } else if (nitFileId) {
      // "Prepare selected" case: no fresh upload on this request, but a
      // previously-uploaded NIT (from the /analyze scan step) was reused -
      // fetch and read that instead of leaving nitText null.
      const nitFileRow = db.prepare('SELECT * FROM file_library WHERE id = ?').get(nitFileId);
      if (nitFileRow) {
        const reusedNitBuffer = await storage.getObject(nitFileRow.storage_key);
        nitText = await extractText(reusedNitBuffer, nitFileRow.mime_type, nitFileRow.original_name);
      }
    }

    // Build the set of real past certificates the AI compares against to
    // learn this category's actual pattern (Annexure or not, wording,
    // structure) - never a single template, never a hardcoded per-category
    // rule. Two sources, always merged rather than one replacing the other:
    //  1. Engagement match (needs NIT text): ask the AI which past tender
    //     engagement on file is most similar to this new tender, then use
    //     ALL the real certificates issued for that one matched tender_no
    //     (any category) - a single past engagement often needed several
    //     certificate types together, so this gives a coherent, tender-
    //     consistent set of examples instead of same-category certificates
    //     pulled from unrelated engagements.
    //  2. Same-category fallback (always computed): the 3 most recent real
    //     certificates in this exact category, regardless of tender. This
    //     used to run ONLY when there was no engagement match - but a
    //     matched engagement can easily have no certificate at all in the
    //     category being drafted right now (or one with no extractable
    //     document), which left the AI with zero examples of that
    //     category's own pattern. It is now always included alongside
    //     whatever the engagement match contributes, de-duplicated by id.
    let referenceTemplates = [];
    let referenceSource = null;
    if (category || nitText) {
      const allCertificates = db.prepare('SELECT * FROM certificates').all();

      // Path 1: engagement match (needs NIT text) - every real certificate
      // issued for the one past tender the AI judges most similar, any
      // category, up to 6.
      let engagementSourceCerts = [];
      let engagementMatch = null;
      if (nitText) {
        const pastEngagements = buildPastEngagements(allCertificates);
        try {
          engagementMatch = await matchSimilarEngagement({ nitText, pastEngagements });
        } catch (e) {
          engagementMatch = null; // never blocks drafting - falls back below
        }
        if (engagementMatch) {
          engagementSourceCerts = findCertificatesByTenderNo(allCertificates, engagementMatch.tenderNo, 6);
        }
      }

      // Path 2: same-category real certificates, up to 3. Always computed
      // (not only when there's no engagement match) - a matched engagement
      // can easily turn out to have no certificate at all in the category
      // actually being drafted right now (or one with no extractable
      // document), and without at least one same-category example the AI
      // has no way to learn that category's own Annexure/structure pattern,
      // which is the whole point of this reference-certificate mechanism.
      // Excludes the 4 blank/master template rows generically (see
      // template-matcher.js#isRealCertificate) - those are placeholder
      // forms, not real issued certificates, and would otherwise dilute or
      // mislead the pattern the AI is meant to learn from real ones.
      const categorySourceCerts = category ? findRecentRealCertificates(allCertificates, category, 3) : [];

      // Merge, de-duplicated by id, engagement-matched certs first (they
      // carry the richer same-tender context) followed by any same-category
      // certs the engagement match didn't already include. Capped at
      // MAX_REFERENCE_CERTS - see the comment on that constant above.
      const seenIds = new Set();
      const sourceCerts = [];
      for (const c of [...engagementSourceCerts, ...categorySourceCerts]) {
        if (sourceCerts.length >= MAX_REFERENCE_CERTS) break;
        if (seenIds.has(c.id)) continue;
        seenIds.add(c.id);
        sourceCerts.push(c);
      }

      if (engagementMatch && engagementSourceCerts.length > 0) {
        referenceSource = { via: 'engagement', tenderNo: engagementMatch.tenderNo, reasoning: engagementMatch.reasoning };
      } else if (sourceCerts.length > 0) {
        referenceSource = { via: 'category' };
      }

      const sourceCertSkipped = [];
      for (const cert of sourceCerts) {
        const doc = db
          .prepare(
            `SELECT cd.*, fl.storage_key, fl.mime_type, fl.original_name
             FROM certificate_documents cd JOIN file_library fl ON fl.id = cd.file_id
             WHERE cd.certificate_id = ?
             ORDER BY (cd.doc_type = 'certificate') DESC, cd.id ASC
             LIMIT 1`
          )
          .get(cert.id);
        if (!doc) {
          sourceCertSkipped.push({ id: cert.id, category: cert.category, reason: 'no certificate_documents row' });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const buf = await storage.getObject(doc.storage_key);
        // eslint-disable-next-line no-await-in-loop
        const extracted = await withTimeout(extractText(buf, doc.mime_type, doc.original_name), REFERENCE_EXTRACT_TIMEOUT_MS);
        if (extracted && extracted.__timedOut) {
          sourceCertSkipped.push({ id: cert.id, category: cert.category, reason: 'extraction timed out (likely a slow OCR pass on a scanned document)' });
        } else if (extracted) {
          referenceTemplates.push({ id: cert.id, fy: cert.fy, category: cert.category, text: extracted });
        } else {
          sourceCertSkipped.push({ id: cert.id, category: cert.category, reason: 'no extractable text', mimeType: doc.mime_type });
        }
      }

      // Extra diagnostic detail on the reference documents themselves - is
      // the stored document actually the certificate letter, or something
      // much larger (a bundled financial-statements attachment) where the
      // sliced prompt excerpt (draftFromTemplate slices each to 4000 chars)
      // might land before the certificate's own Annexure ever appears.
      const referenceDocDebug = referenceTemplates.map((t) => {
        const annexureIdx = t.text.indexOf('Annexure');
        return {
          id: t.id,
          textLen: t.text.length,
          head300: t.text.slice(0, 300),
          around4000: t.text.slice(3800, 4400),
          annexureFirstIdx: annexureIdx,
        };
      });

      // Best-effort diagnostic snapshot - never blocks drafting, just recorded
      // on the row so a request's outcome (e.g. a missing Annexure) can be
      // traced back to which reference certificates it actually got and why,
      // without digging through server logs.
      debugInfo = {
        nitTextLen: nitText ? nitText.length : 0,
        referenceSource,
        referenceTemplates: referenceTemplates.map((t) => ({ id: t.id, category: t.category, fy: t.fy, textLen: t.text.length })),
        sourceCertSkipped,
        referenceDocDebug,
      };
    }

    if (referenceSource) {
      console.log(
        `Draft request #${requestId}: reference certificates sourced via ${referenceSource.via}` +
          (referenceSource.via === 'engagement'
            ? ` (matched tender_no "${referenceSource.tenderNo}"${referenceSource.reasoning ? ` - ${referenceSource.reasoning}` : ''})`
            : '') +
          `, ${referenceTemplates.length} certificate(s).`
      );
    }

    if (!nitText && referenceTemplates.length === 0) {
      throw new Error(
        'Could not extract usable text from either the NIT upload or any past certificate on file for this category (unsupported format, scanned image, or no certificate on file) - nothing safe to draft from automatically.'
      );
    }

    const draftText = await draftFromTemplate({
      category,
      requestType,
      referenceTemplates,
      nitText,
      notes,
      certMeta: template,
      signingPartner,
      certificateLocation,
    });

    const buffer = Buffer.from(draftText, 'utf8');
    const sha256 = storage.sha256Buffer(buffer);
    const filename = `AI-DRAFT-${category || requestType}-request-${requestId}.txt`;
    const key = storage.keyForHash(sha256, filename);
    await storage.putObject(key, buffer, 'text/plain');
    const fileInfo = db
      .prepare(
        `INSERT INTO file_library (sha256, storage_key, original_name, size_bytes, mime_type)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO NOTHING`
      )
      .run(sha256, key, filename, buffer.length, 'text/plain');
    const fileRow = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(sha256);

    db.prepare(
      `UPDATE draft_requests
       SET result_file_id = ?, status = 'delivered', auto_drafted = 1, auto_draft_error = NULL,
           debug_info = ?, delivered_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(fileRow.id, debugInfo ? JSON.stringify(debugInfo) : null, requestId);

    logAudit(user, 'draft_request.auto_drafted', requestId);
  } catch (e) {
    console.error(`Auto-draft failed for request ${requestId}:`, e.message);
    db.prepare(
      "UPDATE draft_requests SET auto_draft_error = ?, debug_info = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(e.message.slice(0, 500), debugInfo ? JSON.stringify(debugInfo) : null, requestId);
    logAudit(user, 'draft_request.auto_draft_failed', `${requestId}: ${e.message}`);
  }
}

// Downloads the delivered result of a request. Clients can only fetch their
// own; admin/team (with the 'drafting' permission) can fetch any - they can
// already see every request via GET '/', this just lets them grab the file.
router.get('/:id/result', requireRole('client', 'admin', 'team'), async (req, res) => {
  if (req.user.role === 'team' && !(req.user.permissions && req.user.permissions.drafting)) {
    return res.status(403).json({ error: 'Missing permission: drafting' });
  }
  const request =
    req.user.role === 'client'
      ? db.prepare('SELECT * FROM draft_requests WHERE id = ? AND submitted_by_user_id = ?').get(req.params.id, req.user.id)
      : db.prepare('SELECT * FROM draft_requests WHERE id = ?').get(req.params.id);
  if (!request || !request.result_file_id) return res.status(404).json({ error: 'Not found' });
  const file = db.prepare('SELECT * FROM file_library WHERE id = ?').get(request.result_file_id);
  try {
    const buffer = await storage.getObject(file.storage_key);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.original_name.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// Client lists their own requests.
router.get('/mine', requireRole('client'), (req, res) => {
  res.json(
    db
      .prepare('SELECT * FROM draft_requests WHERE submitted_by_user_id = ? ORDER BY created_at DESC')
      .all(req.user.id)
  );
});

// Admin: list/review all requests.
router.get('/', requireRole('admin', 'team'), requirePermission('drafting'), (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT dr.*, u.username AS submitted_by
         FROM draft_requests dr JOIN users u ON u.id = dr.submitted_by_user_id
         ORDER BY dr.created_at DESC`
      )
      .all()
  );
});

router.patch('/:id/status', requireRole('admin', 'team'), requirePermission('drafting'), (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'in_review', 'delivered'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  db.prepare("UPDATE draft_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
    status,
    req.params.id
  );
  logAudit(req.user, 'draft_request.status', `${req.params.id} -> ${status}`);
  res.json(db.prepare('SELECT * FROM draft_requests WHERE id = ?').get(req.params.id));
});

// Admin delivers the finished result: uploads the drafted document, marks
// delivered, and it becomes visible/downloadable in the client's portal.
router.post(
  '/:id/deliver',
  requireRole('admin', 'team'),
  requirePermission('drafting'),
  upload.single('result'),
  async (req, res) => {
    const request = db.prepare('SELECT * FROM draft_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (!req.file) return res.status(400).json({ error: 'result file is required' });

    const sha256 = storage.sha256Buffer(req.file.buffer);
    const key = storage.keyForHash(sha256, req.file.originalname);
    await storage.putObject(key, req.file.buffer, req.file.mimetype);
    const info = db
      .prepare(
        `INSERT INTO file_library (sha256, storage_key, original_name, size_bytes, mime_type)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sha256) DO NOTHING`
      )
      .run(sha256, key, req.file.originalname, req.file.buffer.length, req.file.mimetype);
    const fileRow = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(sha256);

    db.prepare(
      "UPDATE draft_requests SET result_file_id = ?, status = 'delivered', delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(fileRow.id, req.params.id);

    logAudit(req.user, 'draft_request.deliver', req.params.id);
    res.json(db.prepare('SELECT * FROM draft_requests WHERE id = ?').get(req.params.id));
  }
);

module.exports = router;
