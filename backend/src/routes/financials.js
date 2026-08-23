const express = require('express');
const db = require('../db');
const { requireRole, requirePermission } = require('../auth');

const router = express.Router();

router.use(requireRole('admin', 'team'), requirePermission('tracking'));

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM financial_documents ORDER BY fy DESC').all());
});

// Auto-suggest annexures by FY: given a target FY, return financial docs
// that cover that year, most specific ("as of" dated) first.
router.get('/suggest', (req, res) => {
  const { fy } = req.query;
  if (!fy) return res.status(400).json({ error: 'fy query param is required' });
  const docs = db
    .prepare('SELECT * FROM financial_documents WHERE fy = ? ORDER BY as_of_date DESC')
    .all(fy);
  res.json(docs);
});

module.exports = router;
