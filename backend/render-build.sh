#!/usr/bin/env bash
# Render Build Command should be: bash render-build.sh
# (replaces a plain "npm install" - does that, plus fetches the litestream
# binary used by start.sh to keep the SQLite database alive across deploys)
set -euo pipefail

echo "[render-build] npm install"
npm install

echo "[render-build] fetching litestream binary"
mkdir -p .bin
# Pinned to a verified-working release URL rather than resolved dynamically:
# litestream's Linux asset is named with "x86_64" (not "amd64") and no "v"
# prefix in the filename itself - e.g. litestream-0.5.16-linux-x86_64.tar.gz -
# confirmed by directly testing the URL below returns 200.
# To upgrade later: check https://github.com/benbjohnson/litestream/releases
# for the newest version and update both LITESTREAM_VERSION and the URL.
LITESTREAM_VERSION="0.5.16"
LITESTREAM_ASSET_URL="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"

echo "[render-build] downloading: $LITESTREAM_ASSET_URL"
if curl -fsSL "$LITESTREAM_ASSET_URL" | tar -xz -C .bin litestream; then
  chmod +x .bin/litestream
  echo "[render-build] litestream binary ready"
else
  echo "[render-build] ERROR: litestream download/extract failed" >&2
  echo "[render-build] falling back to plain node (start.sh handles this safely)" >&2
  rm -f .bin/litestream
fi

echo "[render-build] done"
