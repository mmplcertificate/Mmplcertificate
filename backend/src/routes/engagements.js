const express = require('express');
const db = require('../db');
const { requireRole, requirePermission } = require('../auth');

const router = express.Router();

router.use(requireRole('admin', 'team'), requirePermission('tracking'));

// Parses either DD.MM.YYYY or MM-DD-YYYY prefix from a folder name.
// Undated folders sort last (returns null).
function engagementSortKey(folderName) {
  let m = folderName.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return new Date(`${yyyy}-${mm}-${dd}`).getTime();
  }
  m = folderName.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return new Date(`${yyyy}-${mm}-${dd}`).getTime();
  }
  return null;
}

router.get('/', (req, res) => {
  const engagements = db.prepare('SELECT * FROM engagements').all();
  const withCounts = engagements.map((e) => {
    const files = db.prepare('SELECT * FROM engagement_files WHERE engagement_id = ?').all(e.id);
    const ready = files.filter((f) => f.embedded).length;
    const sortKey = engagementSortKey(e.folder_name);
    return { ...e, file_count: files.length, ready_count: ready, sort_key: sortKey };
  });
  withCounts.sort((a, b) => {
    if (a.sort_key === null && b.sort_key === null) return 0;
    if (a.sort_key === null) return 1;
    if (b.sort_key === null) return -1;
    return b.sort_key - a.sort_key; // latest first
  });
  res.json(withCounts);
});

router.get('/:id/files', (req, res) => {
  const engagement = db.prepare('SELECT * FROM engagements WHERE id = ?').get(req.params.id);
  if (!engagement) return res.status(404).json({ error: 'Not found' });
  const files = db
    .prepare(
      `SELECT ef.*, fl.original_name, fl.size_bytes, fl.mime_type
       FROM engagement_files ef
       LEFT JOIN file_library fl ON fl.id = ef.file_id
       WHERE ef.engagement_id = ?`
    )
    .all(req.params.id);
  res.json({ engagement, files });
});

module.exports = router;
