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
const { matchFromText } = require('../lib/template-matcher');
const { extractText, extractTextWithPages } = require('../lib/document-text');
const { draftFromTemplate, analyzeTenderDocument, isConfigured } = require('../lib/ai-provider');
const { notifyNewDraftRequest } = require('../lib/notify');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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
  const { request_type, category, notes } = req.body || {};
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
      `INSERT INTO draft_requests (submitted_by_user_id, request_type, category, notes, nit_file_id, matched_certificate_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(req.user.id, request_type, category || null, notes || null, nitFileId, template ? template.id : null);

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
async function attemptAutoDraft({ requestId, requestType, category, notes, nitBuffer, nitMimeType, nitFilename, nitFileId, template, user }) {
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

    let templateText = null;
    if (template) {
      const templateDoc = db
        .prepare(
          `SELECT cd.*, fl.storage_key, fl.mime_type, fl.original_name
           FROM certificate_documents cd JOIN file_library fl ON fl.id = cd.file_id
           WHERE cd.certificate_id = ?
           ORDER BY (cd.doc_type = 'certificate') DESC, cd.id ASC
           LIMIT 1`
        )
        .get(template.id);
      if (templateDoc) {
        const templateBuffer = await storage.getObject(templateDoc.storage_key);
        templateText = await extractText(templateBuffer, templateDoc.mime_type, templateDoc.original_name);
      }
    }

    if (!nitText && !templateText) {
      throw new Error(
        'Could not extract usable text from either the NIT upload or the matched template (unsupported format, scanned image, or no template on file) - nothing safe to draft from automatically.'
      );
    }

    const draftText = await draftFromTemplate({
      category,
      requestType,
      templateText,
      nitText,
      notes,
      certMeta: template,
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
           delivered_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`
    ).run(fileRow.id, requestId);

    logAudit(user, 'draft_request.auto_drafted', requestId);
  } catch (e) {
    console.error(`Auto-draft failed for request ${requestId}:`, e.message);
    db.prepare(
      "UPDATE draft_requests SET auto_draft_error = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(e.message.slice(0, 500), requestId);
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
