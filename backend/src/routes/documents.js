// Mounted at the bare /api prefix in server.js because its own routes span
// several path shapes that don't share one sub-prefix
// (/certificates/:id/documents, /files/:hash/download, etc).
//
// IMPORTANT: permission checks are applied PER-ROUTE here, not with a
// router-level `router.use(requirePermission(...))`. A blanket check at the
// top of this file previously intercepted every /api/* request - including
// /api/engagements, /api/draft-requests, and /api/client-portal - before
// those routers got a turn, because Express tries mounted routers in
// registration order and a path-less `router.use` matches everything under
// its mount prefix. Keep the checks local to each route defined here.
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const db = require('../db');
const storage = require('../storage');
const { requireRole, requirePermission, logAudit } = require('../auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

function findOrCreateFileRecord(buffer, originalName, mimeType, sourcePath) {
  const sha256 = storage.sha256Buffer(buffer);
  let record = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(sha256);
  if (record) return record;
  const key = storage.keyForHash(sha256, originalName);
  // storage.putObject is async; callers of this helper must await the wrapper below.
  return { pending: true, sha256, key, buffer, originalName, mimeType, sourcePath };
}

async function commitFileRecord(pendingOrRecord) {
  if (!pendingOrRecord.pending) return pendingOrRecord;
  const { sha256, key, buffer, originalName, mimeType, sourcePath } = pendingOrRecord;
  await storage.putObject(key, buffer, mimeType);
  const info = db
    .prepare(
      `INSERT INTO file_library (sha256, storage_key, original_name, size_bytes, mime_type, source_path)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(sha256, key, originalName, buffer.length, mimeType || null, sourcePath || null);
  return db.prepare('SELECT * FROM file_library WHERE id = ?').get(info.lastInsertRowid);
}

// List documents attached to a certificate.
router.get(
  '/certificates/:certId/documents',
  requireRole('admin', 'team'),
  requirePermission('downloading'),
  (req, res) => {
    const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.certId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    const docs = db
      .prepare(
        `SELECT cd.*, fl.original_name, fl.size_bytes, fl.mime_type, fl.sha256
         FROM certificate_documents cd
         JOIN file_library fl ON fl.id = cd.file_id
         WHERE cd.certificate_id = ?`
      )
      .all(req.params.certId);
    res.json(docs);
  }
);

// Upload + attach a new document to a certificate.
router.post(
  '/certificates/:certId/documents',
  requireRole('admin', 'team'),
  requirePermission('downloading'),
  upload.single('file'),
  async (req, res) => {
    const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.certId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    try {
      const pending = findOrCreateFileRecord(req.file.buffer, req.file.originalname, req.file.mimetype);
      const fileRecord = await commitFileRecord(pending);
      const info = db
        .prepare(
          `INSERT INTO certificate_documents (certificate_id, file_id, doc_type, display_name)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(certificate_id, file_id) DO UPDATE SET doc_type = excluded.doc_type`
        )
        .run(req.params.certId, fileRecord.id, req.body.doc_type || null, req.body.display_name || req.file.originalname);
      logAudit(req.user, 'document.attach', `cert ${req.params.certId} file ${fileRecord.id}`);
      res.status(201).json(db.prepare('SELECT * FROM certificate_documents WHERE id = ?').get(info.lastInsertRowid || info.changes));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed to store document' });
    }
  }
);

// Attach an existing library file (already uploaded elsewhere) to a certificate.
router.post(
  '/certificates/:certId/documents/attach-existing',
  requireRole('admin', 'team'),
  requirePermission('downloading'),
  (req, res) => {
    const { file_id, doc_type, display_name } = req.body || {};
    const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.certId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    const file = db.prepare('SELECT * FROM file_library WHERE id = ?').get(file_id);
    if (!file) return res.status(404).json({ error: 'File not found in library' });
    const info = db
      .prepare(
        `INSERT INTO certificate_documents (certificate_id, file_id, doc_type, display_name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(certificate_id, file_id) DO UPDATE SET doc_type = excluded.doc_type`
      )
      .run(req.params.certId, file_id, doc_type || null, display_name || file.original_name);
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  }
);

// Detach a document from a certificate (library file itself is kept).
router.delete(
  '/certificates/:certId/documents/:docId',
  requireRole('admin', 'team'),
  requirePermission('downloading'),
  (req, res) => {
    db.prepare('DELETE FROM certificate_documents WHERE id = ? AND certificate_id = ?').run(
      req.params.docId,
      req.params.certId
    );
    logAudit(req.user, 'document.detach', `cert ${req.params.certId} doc ${req.params.docId}`);
    res.json({ ok: true });
  }
);

// Toggle per-document client visibility.
router.patch(
  '/certificates/:certId/documents/:docId/visibility',
  requireRole('admin', 'team'),
  requirePermission('downloading'),
  (req, res) => {
    const visible = req.body && typeof req.body.client_visible === 'boolean' ? (req.body.client_visible ? 1 : 0) : null;
    if (visible === null) return res.status(400).json({ error: 'client_visible boolean is required' });
    const result = db
      .prepare('UPDATE certificate_documents SET client_visible = ? WHERE id = ? AND certificate_id = ?')
      .run(visible, req.params.docId, req.params.certId);
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    logAudit(req.user, 'document.visibility', `doc ${req.params.docId} -> ${visible}`);
    res.json({ ok: true, client_visible: !!visible });
  }
);

// Download a single file by its content hash.
router.get(
  '/files/:hash/download',
  requireRole('admin', 'team'),
  requirePermission('downloading'),
  async (req, res) => {
    const file = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(req.params.hash);
    if (!file) return res.status(404).json({ error: 'Not found' });
    try {
      const buffer = await storage.getObject(file.storage_key);
      res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${file.original_name.replace(/"/g, '')}"`);
      res.send(buffer);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Failed to read file' });
    }
  }
);

// ZIP every document attached to a certificate.
router.get(
  '/certificates/:certId/documents/zip',
  requireRole('admin', 'team'),
  requirePermission('downloading'),
  async (req, res) => {
    const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.certId);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    const docs = db
      .prepare(
        `SELECT cd.*, fl.original_name, fl.storage_key, fl.mime_type
         FROM certificate_documents cd
         JOIN file_library fl ON fl.id = cd.file_id
         WHERE cd.certificate_id = ?`
      )
      .all(req.params.certId);
    if (docs.length === 0) return res.status(404).json({ error: 'No documents attached' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${req.params.certId}-documents.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error(err);
      res.status(500).end();
    });
    archive.pipe(res);
    for (const doc of docs) {
      try {
        const buffer = await storage.getObject(doc.storage_key);
        archive.append(buffer, { name: doc.display_name || doc.original_name });
      } catch (e) {
        console.error(`skipping unreadable file for zip: ${doc.storage_key}`, e);
      }
    }
    await archive.finalize();
  }
);

module.exports = router;
