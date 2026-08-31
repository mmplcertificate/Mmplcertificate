// Storage abstraction: writes/reads files by key.
// Local disk when S3_BUCKET is unset; switches to real S3 automatically once it is set.
// No caller code needs to change at deploy time.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCAL_ROOT = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = process.env.S3_PREFIX || 'mmpl';

let s3Client = null;
let s3Mods = null;
// Set for R2 (or any other S3-compatible, non-AWS provider). Leaving this
// unset preserves the exact original real-AWS-S3 behavior.
const S3_ENDPOINT = process.env.S3_ENDPOINT;
function getS3() {
  if (!s3Client) {
    // Lazy-require so local-disk mode never needs the AWS SDK installed.
    s3Mods = require('@aws-sdk/client-s3');
    const config = { region: process.env.AWS_REGION || 'ap-south-1' };
    if (S3_ENDPOINT) {
      // R2 (and most other S3-compatible services) need an explicit
      // endpoint, 'auto' region, and path-style addressing instead of
      // AWS's default virtual-hosted-style bucket subdomains.
      config.endpoint = S3_ENDPOINT;
      config.region = process.env.AWS_REGION || 'auto';
      config.forcePathStyle = true;
    }
    s3Client = new s3Mods.S3Client(config);
  }
  return s3Client;
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function putObject(key, buffer, contentType) {
  if (S3_BUCKET) {
    const client = getS3();
    await client.send(
      new s3Mods.PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${S3_PREFIX}/${key}`,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
      })
    );
    return key;
  }
  const fullPath = path.join(LOCAL_ROOT, key);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, buffer);
  return key;
}

async function getObject(key) {
  if (S3_BUCKET) {
    const client = getS3();
    const res = await client.send(
      new s3Mods.GetObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}/${key}` })
    );
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const fullPath = path.join(LOCAL_ROOT, key);
  return fs.readFileSync(fullPath);
}

async function deleteObject(key) {
  if (S3_BUCKET) {
    const client = getS3();
    await client.send(
      new s3Mods.DeleteObjectCommand({ Bucket: S3_BUCKET, Key: `${S3_PREFIX}/${key}` })
    );
    return;
  }
  const fullPath = path.join(LOCAL_ROOT, key);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
}

function keyForHash(sha256, originalName) {
  const ext = path.extname(originalName || '');
  return `files/${sha256.slice(0, 2)}/${sha256}${ext}`;
}

// Lists everything under a key prefix (e.g. 'backups') - used by
// scripts/backup-db.js to find and prune old nightly backups. Returns
// {key, lastModified, size} with `key` relative the same way putObject/
// getObject take it (no S3_PREFIX or bucket baked in), so a caller never
// needs to know which storage mode is active.
async function listObjects(prefix) {
  if (S3_BUCKET) {
    const client = getS3();
    const fullPrefix = `${S3_PREFIX}/${prefix}`;
    const out = [];
    let ContinuationToken;
    do {
      // eslint-disable-next-line no-await-in-loop
      const res = await client.send(
        new s3Mods.ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: fullPrefix, ContinuationToken })
      );
      for (const obj of res.Contents || []) {
        out.push({ key: obj.Key.slice(S3_PREFIX.length + 1), lastModified: obj.LastModified, size: obj.Size });
      }
      ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return out;
  }
  const fullPath = path.join(LOCAL_ROOT, prefix);
  if (!fs.existsSync(fullPath)) return [];
  return fs.readdirSync(fullPath).map((name) => {
    const st = fs.statSync(path.join(fullPath, name));
    return { key: `${prefix}/${name}`, lastModified: st.mtime, size: st.size };
  });
}

module.exports = { putObject, getObject, deleteObject, listObjects, sha256Buffer, keyForHash, S3_BUCKET };
