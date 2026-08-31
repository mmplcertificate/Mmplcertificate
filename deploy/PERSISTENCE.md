# Keeping data alive across Render deploys (no code push required)

Render's free tier wipes the local disk on every deploy/restart. Fixed two ways,
both via free Cloudflare R2 storage - no application code changes to any route
or query needed.

## 1. Database - Litestream

`litestream.yml` + `render-build.sh` + `start.sh` continuously stream the SQLite
file's changes to R2 in the background, and restore the latest copy automatically
before the app starts. better-sqlite3 and every existing query are untouched.

## 2. Uploaded documents - storage.js

`src/storage.js` already supports real S3. It now also supports S3-compatible
endpoints (R2) via the new `S3_ENDPOINT` env var - see the storage.js diff.
Point it at the same R2 bucket used for litestream (different key prefix, no
collision - documents live under `S3_PREFIX` (default `mmpl`), litestream's
backup lives under `litestream/`).

## Required Render environment variables

| Variable | Value | Used by |
|---|---|---|
| `LITESTREAM_BUCKET` | your R2 bucket name | start.sh / litestream.yml |
| `S3_BUCKET` | same R2 bucket name | storage.js (turns on R2 document storage) |
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | both |
| `AWS_ACCESS_KEY_ID` | R2 API token Access Key ID | both |
| `AWS_SECRET_ACCESS_KEY` | R2 API token Secret Access Key | both |
| `AWS_REGION` | `auto` | both (storage.js defaults to ap-south-1 otherwise) |

## One-time Render dashboard change

Build Command: `bash render-build.sh`  (was: `npm install` or similar)
Start Command: unchanged (`npm start` - package.json now points at start.sh)

## Verifying it worked

After the next deploy, check the deploy logs for `[start] litestream replication
active`. Then push any trivial change (or just trigger a manual redeploy) and
confirm the certificate data is still there afterward - that's the actual proof,
since this problem never reproduces except across a real redeploy.
