#!/usr/bin/env bash
# Runs INSIDE litestream's -exec (see start.sh). litestream's -exec does not
# go through a shell - it just splits the given string on whitespace and execs
# the first token directly, so "node a.js && node b.js" was silently passed to
# node as literal argv (never actually chaining), which is why migrations ran
# but bootstrap-admin.js and the server itself never started. Routing through
# this actual shell script fixes that: "bash boot.sh" is a valid two-token
# -exec command, and this file's own && chaining works normally inside bash.
set -euo pipefail
node scripts/run-migrations.js
node scripts/bootstrap-admin.js
exec node src/server.js
