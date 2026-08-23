#!/usr/bin/env node
// Bootstrap/reset a user account.
// Usage: node scripts/create-user.js <username> <password> [role] [permissionsJson]
//   role defaults to 'admin' for backward compatibility.
//   permissionsJson only matters for role=team, e.g. '{"tracking":true,"billing":true}'
const db = require('../src/db');
const { hashPassword } = require('../src/auth');

const [, , username, password, role = 'admin', permissionsJson] = process.argv;

if (!username || !password) {
  console.error('Usage: node scripts/create-user.js <username> <password> [role] [permissionsJson]');
  process.exit(1);
}

if (!['admin', 'team', 'client'].includes(role)) {
  console.error(`Invalid role "${role}". Must be one of: admin, team, client.`);
  process.exit(1);
}

let permissions = null;
if (role === 'team') {
  permissions = permissionsJson || '{}';
  try {
    JSON.parse(permissions);
  } catch (e) {
    console.error('permissionsJson must be valid JSON, e.g. \'{"tracking":true}\'');
    process.exit(1);
  }
}

const passwordHash = hashPassword(password);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = ?, permissions = ?, updated_at = datetime('now') WHERE username = ?").run(
    passwordHash,
    role,
    permissions,
    username
  );
  console.log(`Updated existing user "${username}" (role: ${role}).`);
} else {
  db.prepare('INSERT INTO users (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)').run(
    username,
    passwordHash,
    role,
    permissions
  );
  console.log(`Created user "${username}" (role: ${role}).`);
}

if (role === 'team') {
  console.log(`Permissions: ${permissions}`);
} else if (role === 'admin') {
  console.log('Admin accounts always have full access to every permission-gated action.');
} else {
  console.log('Client accounts use the read-only client portal, not the admin/team routes.');
}
