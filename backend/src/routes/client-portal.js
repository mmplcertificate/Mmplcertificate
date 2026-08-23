// Read-only portal for client-role accounts, scoped strictly to
// client_visible=1 certificates/documents. A client account never reaches
// the admin dashboard routes - this is the entire surface it can see.
const express = require('express');
const db = require('../db');
const storage = require('../storage');
const { requireRole } = require('../auth');

const router = express.Router();

router.use(requireRole('client'));

router.get('/certificates', (req, res) => {
  const certs = db.prepare('SELECT * FROM certificates WHERE client_visible = 1 ORDER BY document_date DESC').all();
  const withDocs = certs.map((c) => {
    const docs = db
      .prepare(
        `SELECT cd.id, cd.display_name, fl.sha256, fl.original_name
         FROM certificate_documents cd JOIN file_library fl ON fl.id = cd.file_id
         WHERE cd.certificate_id = ? AND cd.client_visible = 1`
      )
      .all(c.id);
    return { ...c, documents: docs };
  });
  res.json(withDocs);
});

router.get('/documents/:hash/download', async (req, res) => {
  // Only allow downloading a file that is BOTH attached to a client_visible
  // certificate AND itself marked client_visible - never anything else in
  // the library, even if the hash is guessable.
  const allowed = db
    .prepare(
      `SELECT fl.* FROM file_library fl
       JOIN certificate_documents cd ON cd.file_id = fl.id
       JOIN certificates c ON c.id = cd.certificate_id
       WHERE fl.sha256 = ? AND cd.client_visible = 1 AND c.client_visible = 1`
    )
    .get(req.params.hash);
  if (!allowed) return res.status(404).json({ error: 'Not found' });
  try {
    const buffer = await storage.getObject(allowed.storage_key);
    res.setHeader('Content-Type', allowed.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${allowed.original_name.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

module.exports = router;
