#!/usr/bin/env bash
# Render Build Command should be: bash render-build.sh
# (replaces a plain "npm install" - does that, plus fetches the litestream
# binary used by start.sh to keep the SQLite database alive across deploys)
set -euo pipefail

echo "[render-build] npm install"
npm install

echo "[render-build] fetching litestream binary"
mkdir -p .bin
curl -fsSL https://github.com/benbjohnson/litestream/releases/latest/download/litestream-linux-amd64.tar.gz \
  | tar -xz -C .bin litestream
chmod +x .bin/litestream

echo "[render-build] done"
