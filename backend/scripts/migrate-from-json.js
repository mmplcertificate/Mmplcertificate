#!/usr/bin/env node
// Migrates the legacy certificates_data.json (dashboard's own save format) into
// the SQLite schema: certificates + engagements (engagement_files rows are
// created without file_id / embedded=0 here - the real bytes are attached
// later via import-documents.js from the Desktop folder).
//
// Usage: node scripts/migrate-from-json.js <path-to-certificates_data.json> [<path-to-engagements-folder-listing.json>]
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const [, , dataFilePath, engagementsListingPath] = process.argv;

if (!dataFilePath) {
  console.error('Usage: node scripts/migrate-from-json.js <path-to-certificates_data.json> [<path-to-engagements-folder-listing.json>]');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(dataFilePath, 'utf8'));
// The legacy file may be a bare array or { certificates: [...] }.
const certificates = Array.isArray(raw) ? raw : raw.certificates || [];

const insertCert = db.prepare(`INSERT INTO certificates
  (stage, category, client, owner, tender_no, fy, particulars, document_date,
   signing_date, target_date, amount, udin, bill_no, bill_date, notes, created_at, updated_at)
  VALUES (@stage, @category, @client, @owner, @tender_no, @fy, @particulars, @document_date,
   @signing_date, @target_date, @amount, @udin, @bill_no, @bill_date, @notes, @created_at, @updated_at)`);

const tx = db.transaction((rows) => {
  let count = 0;
  for (const c of rows) {
    insertCert.run({
      stage: c.stage || 'in_progress',
      category: c.category || null,
      client: c.client || null,
      owner: c.owner || null,
      tender_no: c.tender_no || null,
      fy: c.fy || null,
      particulars: c.particulars || null,
      document_date: c.document_date || null,
      signing_date: c.signing_date || null,
      target_date: c.target_date || null,
      amount: c.amount != null ? Number(c.amount) : null,
      udin: c.udin || null,
      bill_no: c.bill_no || null,
      bill_date: c.bill_date || null,
      notes: c.notes || null,
      created_at: c.created_at || new Date().toISOString(),
      updated_at: c.updated_at || new Date().toISOString(),
    });
    count += 1;
  }
  return count;
});

const certCount = tx(certificates);
console.log(`Migrated ${certCount} certificates.`);

if (engagementsListingPath && fs.existsSync(engagementsListingPath)) {
  const listing = JSON.parse(fs.readFileSync(engagementsListingPath, 'utf8'));
  const folders = Array.isArray(listing) ? listing : listing.folders || [];
  const insertEngagement = db.prepare('INSERT INTO engagements (folder_name, folder_path) VALUES (?, ?)');
  const insertFile = db.prepare('INSERT INTO engagement_files (engagement_id, relative_path, embedded) VALUES (?, ?, 0)');
  const engTx = db.transaction((rows) => {
    let engCount = 0;
    let fileCount = 0;
    for (const folder of rows) {
      const info = insertEngagement.run(folder.name || path.basename(folder.path), folder.path);
      for (const file of folder.files || []) {
        insertFile.run(info.lastInsertRowid, file);
        fileCount += 1;
      }
      engCount += 1;
    }
    return { engCount, fileCount };
  });
  const { engCount, fileCount } = engTx(folders);
  console.log(`Migrated ${engCount} engagement folders (${fileCount} file references, not yet embedded).`);
} else {
  console.log('No engagements listing provided - skipping engagement folder migration.');
}
