const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
const LOCAL_UPLOAD_ROOT = process.env.LOCAL_UPLOAD_ROOT || path.join(__dirname, '..', 'data', 'uploads');
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set(['.exe', '.sh', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.jar', '.app']);

let s3Client = null;
let s3Bucket = process.env.S3_BUCKET || '';
let s3Region = process.env.S3_REGION || 'us-east-1';
let s3Endpoint = process.env.S3_ENDPOINT || '';
let s3AccessKeyId = process.env.S3_ACCESS_KEY_ID || '';
let s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY || '';
let s3CdnUrl = process.env.S3_CDN_URL || '';
let s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: s3Region,
      endpoint: s3Endpoint || undefined,
      credentials: {
        accessKeyId: s3AccessKeyId,
        secretAccessKey: s3SecretAccessKey,
      },
      forcePathStyle: s3ForcePathStyle,
    });
  }
  return s3Client;
}

function generateKey(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

function validateFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`Files of type "${ext}" are not allowed.`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit.`);
  }
}

async function uploadFileLocal(file, key) {
  const fs = require('fs');
  const destPath = path.join(LOCAL_UPLOAD_ROOT, key);
  if (!fs.existsSync(LOCAL_UPLOAD_ROOT)) fs.mkdirSync(LOCAL_UPLOAD_ROOT, { recursive: true });
  await fs.promises.copyFile(file.path, destPath);
  await fs.promises.unlink(file.path);
  return { key, url: `/uploads/${key}`, driver: 'local' };
}

async function uploadFileS3(file, key) {
  const client = getS3Client();
  const fs = require('fs');
  const fileStream = fs.createReadStream(file.path);
  await client.send(new PutObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    Body: fileStream,
    ContentType: file.mimetype,
    ContentDisposition: `inline; filename="${file.originalname}"`,
  }));
  await fs.promises.unlink(file.path);
  const url = s3CdnUrl ? `${s3CdnUrl}/${key}` : await getSignedUrl(client, new GetObjectCommand({ Bucket: s3Bucket, Key: key }), { expiresIn: 3600 });
  return { key, url, driver: 's3' };
}

async function uploadFile(file) {
  validateFile(file);
  const key = generateKey(file.originalname);
  if (STORAGE_DRIVER === 's3') {
    return uploadFileS3(file, key);
  }
  return uploadFileLocal(file, key);
}

async function deleteFile(key, driver) {
  if (driver === 's3' || STORAGE_DRIVER === 's3') {
    const client = getS3Client();
    await client.send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));
  } else {
    const fs = require('fs');
    const filePath = path.join(LOCAL_UPLOAD_ROOT, key);
    if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
  }
}

function getPublicUrl(key, driver) {
  if (driver === 's3' || STORAGE_DRIVER === 's3') {
    if (s3CdnUrl) return `${s3CdnUrl}/${key}`;
    const client = getS3Client();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: s3Bucket, Key: key }), { expiresIn: 3600 });
  }
  return `/uploads/${key}`;
}

module.exports = {
  uploadFile,
  deleteFile,
  getPublicUrl,
  MAX_FILE_SIZE,
  STORAGE_DRIVER,
  LOCAL_UPLOAD_ROOT,
};