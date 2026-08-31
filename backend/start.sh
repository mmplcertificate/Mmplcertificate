#!/usr/bin/env bash
# Render Start Command stays: npm start (package.json's "start" now calls this file)
set -euo pipefail

if [ -n "${LITESTREAM_BUCKET:-}" ] && [ -x "./.bin/litestream" ]; then
  echo "[start] litestream replication active -> bucket: ${LITESTREAM_BUCKET}"
  exec ./.bin/litestream replicate -config litestream.yml -exec "bash boot.sh"
else
  echo "[start] LITESTREAM_BUCKET not set (or binary missing) - plain node, no replication"
  echo "[start] this is expected for local dev; on Render this means the DB env vars are missing"
  node scripts/run-migrations.js
  node scripts/bootstrap-admin.js
  exec node src/server.js
fi
