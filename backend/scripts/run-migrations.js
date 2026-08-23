#!/usr/bin/env node
// Applies every migrations/*.sql file that hasn't been applied yet, in filename order.
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const applied = new Set(
  db.prepare('SELECT filename FROM schema_migrations').all().map((r) => r.filename)
);

const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let ranAny = false;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  console.log(`Applying migration: ${file}`);
  db.exec(sql);
  db.prepare('INSERT INTO schema_migrations (filename) VALUES (?)').run(file);
  ranAny = true;
}

if (!ranAny) {
  console.log('No pending migrations. Database is up to date.');
} else {
  console.log('Migrations complete.');
}
