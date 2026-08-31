#!/usr/bin/env node
// Ensures at least one login exists on a brand-new database - e.g. the very
// first deploy where litestream had no prior snapshot to restore, so the
// schema was just created empty by run-migrations.js and there is no way to
// log in yet. Safe to run on every boot: it only acts when the users table
// is completely empty, so it never touches a database that already has
// accounts (including one restored from a real litestream snapshot).
const db = require('../src/db');
const { hashPassword } = require('../src/auth');

const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD;

const { c: count } = db.prepare('SELECT COUNT(*) AS c FROM users').get();

if (count > 0) {
  console.log(`[bootstrap-admin] ${count} user(s) already exist - skipping.`);
  process.exit(0);
}

if (!password) {
  console.warn(
    '[bootstrap-admin] No users exist and ADMIN_PASSWORD is not set - skipping. ' +
    'Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) in Render env vars to ' +
    'auto-create a login on a fresh database.'
  );
  process.exit(0);
}

const passwordHash = hashPassword(password);
db.prepare(
  'INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)'
).run(username, passwordHash, 'admin', null);

console.log(`[bootstrap-admin] Created admin user "${username}".`);
