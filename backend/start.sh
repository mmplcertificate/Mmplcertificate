#!/usr/bin/env bash
# Render Start Command stays: npm start (package.json's "start" now calls this file)
set -euo pipefail

# Applying migrations + bootstrapping an admin login on every boot (both are
# safe no-ops once the schema/users already exist) means a brand-new,
# never-before-restored database - e.g. the very first litestream deploy, or
# a future one if the R2 replica is ever empty - comes up ready to log into,
# with no manual Shell step required.
BOOT_CMD="node scripts/run-migrations.js && node scripts/bootstrap-admin.js && node src/server.js"

if [ -n "${LITESTREAM_BUCKET:-}" ] && [ -x "./.bin/litestream" ]; then
  echo "[start] litestream replication active -> bucket: ${LITESTREAM_BUCKET}"
  exec ./.bin/litestream replicate -config litestream.yml -exec "$BOOT_CMD"
else
  echo "[start] LITESTREAM_BUCKET not set (or binary missing) - plain node, no replication"
  echo "[start] this is expected for local dev; on Render this means the DB env vars are missing"
  node scripts/run-migrations.js
  node scripts/bootstrap-admin.js
  exec node src/server.js
fi
