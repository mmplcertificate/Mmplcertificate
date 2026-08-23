#!/usr/bin/env node
// Imports the "MMPL Financials" folder: stores each file in file_library and
// parses its Indian FY / as-of date via fy-matcher for the annexure auto-suggest.
//
// Usage: node scripts/import-financials.js <financials-folder>
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const storage = require('../src/storage');
const { parseFinancialYear } = require('../src/lib/fy-matcher');

const [, , financialsFolder] = process.argv;

if (!financialsFolder) {
  console.error('Usage: node scripts/import-financials.js <financials-folder>');
  process.exit(1);
}

async function main() {
  const files = fs.readdirSync(financialsFolder, { withFileTypes: true }).filter((e) => e.isFile());
  let imported = 0;

  for (const entry of files) {
    const filePath = path.join(financialsFolder, entry.name);
    const buffer = fs.readFileSync(filePath);
    const sha256 = storage.sha256Buffer(buffer);
    let fileRow = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(sha256);
    if (!fileRow) {
      const key = storage.keyForHash(sha256, entry.name);
      // eslint-disable-next-line no-await-in-loop
      await storage.putObject(key, buffer);
      const info = db
        .prepare(
          `INSERT INTO file_library (sha256, storage_key, original_name, size_bytes, source_path)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(sha256, key, entry.name, buffer.length, filePath);
      fileRow = db.prepare('SELECT * FROM file_library WHERE id = ?').get(info.lastInsertRowid);
    }
    const { fy, asOfDate } = parseFinancialYear(entry.name);
    db.prepare(
      `INSERT INTO financial_documents (file_id, original_name, fy, as_of_date) VALUES (?, ?, ?, ?)`
    ).run(fileRow.id, entry.name, fy, asOfDate);
    imported += 1;
    console.log(`${entry.name} -> FY ${fy || 'unknown'}${asOfDate ? ` (as of ${asOfDate})` : ''}`);
  }

  console.log(`Imported ${imported} financial documents.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
