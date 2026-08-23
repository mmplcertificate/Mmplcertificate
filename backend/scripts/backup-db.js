#!/usr/bin/env node
// Nightly database backup - run by a cron entry ec2-bootstrap.sh installs.
//
// Uses better-sqlite3's own .backup() API rather than a plain file copy:
// the live database runs in WAL mode, so copying mmpl.sqlite3 directly can
// grab a half-written/inconsistent snapshot while the app is serving
// requests. .backup() is safe to run against a live database.
//
// Uploads through the same storage.js abstraction certificates/documents
// already use - S3 automatically if S3_BUCKET is set (the normal case once
// deployed, since cloudshell-setup.sh always provisions a bucket), local
// disk otherwise (e.g. for a quick local test). Prunes anything older than
// BACKUP_RETENTION_DAYS (default 14) so storage doesn't grow forever.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const storage = require('../src/storage');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'mmpl.sqlite3');
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10);

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database found at ${DB_PATH} - nothing to back up.`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpPath = path.join(os.tmpdir(), `mmpl-backup-${stamp}.sqlite3`);

  const db = new Database(DB_PATH);
  try {
    await db.backup(tmpPath);
  } finally {
    db.close();
  }

  const buffer = fs.readFileSync(tmpPath);
  const key = `backups/mmpl-${stamp}.sqlite3`;
  await storage.putObject(key, buffer, 'application/x-sqlite3');
  fs.unlinkSync(tmpPath);
  console.log(
    `Backup uploaded: ${key} (${(buffer.length / 1024 / 1024).toFixed(2)} MB) -> ${
      storage.S3_BUCKET ? `S3 bucket ${storage.S3_BUCKET}` : 'local disk (backend/storage/backups)'
    }`
  );

  // Prune anything past retention. A failure here (e.g. a transient S3
  // hiccup) is logged but never turns a successful backup into a failed run.
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const existing = await storage.listObjects('backups');
    const stale = existing.filter((f) => new Date(f.lastModified).getTime() < cutoff);
    for (const f of stale) {
      // eslint-disable-next-line no-await-in-loop
      await storage.deleteObject(f.key);
      console.log(`Pruned old backup: ${f.key}`);
    }
  } catch (e) {
    console.error('Backup pruning step failed (backup itself still succeeded):', e.message);
  }
}

main().catch((e) => {
  console.error('Backup failed:', e.message);
  process.exit(1);
});
