#!/usr/bin/env node
// Walks a local folder of engagement documents (staged from the Desktop via
// the device bridge, or copied some other way onto this machine) and imports
// every file into file_library (deduped by sha256) plus engagement_files rows,
// marking embedded=1 for each file actually stored.
//
// Usage: node scripts/import-documents.js <root-folder>
// Expects <root-folder> to contain one subfolder per engagement, matching the
// folder_name values already migrated by migrate-from-json.js.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const storage = require('../src/storage');

const [, , rootFolder] = process.argv;

if (!rootFolder) {
  console.error('Usage: node scripts/import-documents.js <root-folder>');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

async function main() {
  const engagements = db.prepare('SELECT * FROM engagements').all();
  const byFolderName = new Map(engagements.map((e) => [e.folder_name, e]));

  let imported = 0;
  let skippedNoEngagement = 0;

  for (const topEntry of fs.readdirSync(rootFolder, { withFileTypes: true })) {
    if (!topEntry.isDirectory()) continue;
    const engagement = byFolderName.get(topEntry.name);
    if (!engagement) {
      skippedNoEngagement += 1;
      console.warn(`No matching engagement row for folder "${topEntry.name}" - skipping.`);
      continue;
    }
    const folderPath = path.join(rootFolder, topEntry.name);
    const files = walk(folderPath);
    for (const filePath of files) {
      const buffer = fs.readFileSync(filePath);
      const sha256 = storage.sha256Buffer(buffer);
      let fileRow = db.prepare('SELECT * FROM file_library WHERE sha256 = ?').get(sha256);
      if (!fileRow) {
        const originalName = path.basename(filePath);
        const key = storage.keyForHash(sha256, originalName);
        // eslint-disable-next-line no-await-in-loop
        await storage.putObject(key, buffer);
        const info = db
          .prepare(
            `INSERT INTO file_library (sha256, storage_key, original_name, size_bytes, source_path)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(sha256, key, originalName, buffer.length, filePath);
        fileRow = db.prepare('SELECT * FROM file_library WHERE id = ?').get(info.lastInsertRowid);
      }
      const relativePath = path.relative(folderPath, filePath);
      db.prepare(
        `INSERT INTO engagement_files (engagement_id, file_id, relative_path, embedded)
         VALUES (?, ?, ?, 1)`
      ).run(engagement.id, fileRow.id, relativePath);
      imported += 1;
    }
  }

  console.log(`Imported ${imported} files. Folders with no matching engagement row: ${skippedNoEngagement}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
