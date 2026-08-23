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
function getS3() {
  if (!s3Client) {
    // Lazy-require so local-disk mode never needs the AWS SDK installed.
    s3Mods = require('@aws-sdk/client-s3');
    s3Client = new s3Mods.S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });
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

module.exports = { putObject, getObject, deleteObject, sha256Buffer, keyForHash, S3_BUCKET };
