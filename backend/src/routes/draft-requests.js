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
const { extractText } = require('../lib/document-text');
const { draftFromTemplate } = require('../lib/gemini-client');
const { notifyNewDraftRequest } = require('../lib/notify');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Submit a new request (NIT upload + auto-template-match). Clients always
// use this to reach Akash; admin/team can also submit here themselves -
// e.g. to test how the matching/drafting pipeline behaves on a real NIT
// without needing a separate client login.
router.post(
  '/',
  requireRole('client', 'admin', 'team'),
  (req, res, next) => {
    // Team members need the 'drafting' permission (same one that gates the
    // Client Requests tab) to submit a test request. Admin and client
    // always pass this check.
    if (req.user.role === 'team' && !(req.user.permissions && req.user.permissions.drafting)) {
      return res.status(403).json({ error: 'Missing permission: drafting' });
    }
    next();
  },
  upload.single('nit'),
  async (req, res) => {
  const { request_type, category, notes } = req.body || {};
  if (!request_type) return res.status(400).json({ error: 'request_type is required' });

  let nitFileId = null;
  let matchText = `${category || ''} ${notes || ''} ${req.file ? req.file.originalname : ''}`;

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
  }

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

  if (process.env.GEMINI_API_KEY) {
    await attemptAutoDraft({
      requestId: info.lastInsertRowid,
      requestType: request_type,
      category: category || detectedCategory,
      notes,
      nitBuffer: req.file ? req.file.buffer : null,
      nitMimeType: req.file ? req.file.mimetype : null,
      nitFilename: req.file ? req.file.originalname : null,
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
async function attemptAutoDraft({ requestId, requestType, category, notes, nitBuffer, nitMimeType, nitFilename, template, user }) {
  try {
    const nitText = nitBuffer ? await extractText(nitBuffer, nitMimeType, nitFilename) : null;

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
