#!/usr/bin/env bash
# Render Build Command should be: bash render-build.sh
# (replaces a plain "npm install" - does that, plus fetches the litestream
# binary used by start.sh to keep the SQLite database alive across deploys)
set -euo pipefail

echo "[render-build] npm install"
npm install

echo "[render-build] fetching litestream binary"
mkdir -p .bin
# Each litestream release embeds its version in the asset filename (e.g.
# litestream-v0.5.16-linux-amd64.tar.gz), so there's no fixed "latest" URL -
# resolve it from the GitHub API instead of guessing a filename.
LITESTREAM_ASSET_URL=$(curl -fsSL https://api.github.com/repos/benbjohnson/litestream/releases/latest \
  | grep '"browser_download_url"' \
  | grep 'linux-amd64.tar.gz' \
  | grep -v -- '-vfs-' \
  | grep -v -- '-static' \
  | head -1 \
  | cut -d '"' -f 4) || true
# (the "|| true" above matters: with set -e + pipefail, a grep finding no
# match would otherwise abort the whole script here instead of reaching
# the graceful fallback check below)

if [ -z "$LITESTREAM_ASSET_URL" ]; then
  echo "[render-build] ERROR: could not resolve the litestream download URL from the GitHub API" >&2
  echo "[render-build] falling back to plain node (start.sh handles this safely)" >&2
else
  echo "[render-build] downloading: $LITESTREAM_ASSET_URL"
  curl -fsSL "$LITESTREAM_ASSET_URL" | tar -xz -C .bin litestream
  chmod +x .bin/litestream
fi

echo "[render-build] done"
