const express = require('express');
const db = require('../db');
const { requirePermission, requireRole, logAudit } = require('../auth');

const router = express.Router();

// GET is tracking-gated (read access); mutations are billing-gated.
router.get('/', requireRole('admin', 'team'), requirePermission('tracking'), (req, res) => {
  const { stage, owner, fy, category, q } = req.query;
  let sql = 'SELECT * FROM certificates WHERE 1=1';
  const params = [];
  if (stage) {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  if (owner) {
    sql += ' AND owner = ?';
    params.push(owner);
  }
  if (fy) {
    sql += ' AND fy = ?';
    params.push(fy);
  }
  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (q) {
    sql += ' AND (particulars LIKE ? OR tender_no LIKE ? OR udin LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY document_date DESC, id DESC';
  res.json(db.prepare(sql).all(...params));
});

router.get('/:id', requireRole('admin', 'team'), requirePermission('tracking'), (req, res) => {
  const cert = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!cert) return res.status(404).json({ error: 'Not found' });
  res.json(cert);
});

router.post('/', requireRole('admin', 'team'), requirePermission('billing'), (req, res) => {
  const b = req.body || {};
  const stmt = db.prepare(`INSERT INTO certificates
    (stage, category, client, owner, tender_no, fy, particulars, document_date,
     signing_date, target_date, amount, udin, bill_no, bill_date, notes)
    VALUES (@stage, @category, @client, @owner, @tender_no, @fy, @particulars, @document_date,
     @signing_date, @target_date, @amount, @udin, @bill_no, @bill_date, @notes)`);
  const info = stmt.run({
    stage: b.stage || 'in_progress',
    category: b.category || null,
    client: b.client || null,
    owner: b.owner || null,
    tender_no: b.tender_no || null,
    fy: b.fy || null,
    particulars: b.particulars || null,
    document_date: b.document_date || null,
    signing_date: b.signing_date || null,
    target_date: b.target_date || null,
    amount: b.amount != null ? Number(b.amount) : null,
    udin: b.udin || null,
    bill_no: b.bill_no || null,
    bill_date: b.bill_date || null,
    notes: b.notes || null,
  });
  logAudit(req.user, 'certificate.create', info.lastInsertRowid);
  res.status(201).json(db.prepare('SELECT * FROM certificates WHERE id = ?').get(info.lastInsertRowid));
});

const PATCHABLE_FIELDS = [
  'stage', 'category', 'client', 'owner', 'tender_no', 'fy', 'particulars',
  'document_date', 'signing_date', 'target_date', 'amount', 'udin',
  'bill_no', 'bill_date', 'notes', 'client_visible',
];

router.patch('/:id', requireRole('admin', 'team'), requirePermission('billing'), (req, res) => {
  const existing = db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const updates = [];
  const params = {};
  for (const field of PATCHABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      let value = req.body[field];
      // SQLite bindings only accept numbers/strings/bigints/buffers/null -
      // coerce booleans (e.g. client_visible: true/false from the JSON body)
      // to 1/0 before binding, otherwise better-sqlite3 throws a 500.
      if (typeof value === 'boolean') value = value ? 1 : 0;
      updates.push(`${field} = @${field}`);
      params[field] = value;
    }
  }
  if (updates.length === 0) return res.json(existing);
  params.id = req.params.id;
  db.prepare(
    `UPDATE certificates SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = @id`
  ).run(params);
  logAudit(req.user, 'certificate.update', req.params.id);
  res.json(db.prepare('SELECT * FROM certificates WHERE id = ?').get(req.params.id));
});

router.post('/bulk-assign', requireRole('admin', 'team'), requirePermission('billing'), (req, res) => {
  const { ids, owner } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || !owner) {
    return res.status(400).json({ error: 'ids[] and owner are required' });
  }
  const stmt = db.prepare("UPDATE certificates SET owner = ?, updated_at = datetime('now') WHERE id = ?");
  const tx = db.transaction((idList) => {
    for (const id of idList) stmt.run(owner, id);
  });
  tx(ids);
  logAudit(req.user, 'certificate.bulk_assign', `${ids.length} certs -> ${owner}`);
  res.json({ updated: ids.length });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM certificates WHERE id = ?').run(req.params.id);
  logAudit(req.user, 'certificate.delete', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
