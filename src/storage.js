// File storage for chat attachments, call recordings and profile photos.
//
//   STORAGE_DRIVER=local (default)  files live in LOCAL_UPLOAD_ROOT (data/uploads)
//   STORAGE_DRIVER=s3               new files go to an S3-compatible bucket (AWS S3, MinIO, Backblaze B2,
//                                   Wasabi ...): S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
//                                   S3_REGION, and for a non-AWS service S3_ENDPOINT (+ S3_FORCE_PATH_STYLE=true)
//
// Every stored file remembers its own driver (attachments.storage_driver, recordings.storage_driver),
// so switching the setting only changes where NEW files go: files saved earlier are still read from
// where they are. `src/tools/migrate-uploads-to-s3.js` moves the old ones across.
//
// Downloads are streamed through the app (never a link to the bucket): the person's access is
// checked on every download, the bucket can stay private and unreachable from browsers, and an
// internal endpoint (a MinIO container) works. Range requests are passed on, so recordings can be
// played and scrubbed. S3_CDN_URL, if set, is the one exception: downloads redirect to that public URL.
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
const LOCAL_UPLOAD_ROOT = process.env.LOCAL_UPLOAD_ROOT || path.join(__dirname, '..', 'data', 'uploads');
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024;
const BLOCKED_EXTENSIONS = new Set(['.exe', '.sh', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.jar', '.app']);

const s3Bucket = process.env.S3_BUCKET || '';
const s3Region = process.env.S3_REGION || 'us-east-1';
const s3Endpoint = process.env.S3_ENDPOINT || '';
const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID || '';
const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY || '';
const s3CdnUrl = (process.env.S3_CDN_URL || '').replace(/\/+$/, '');
const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

let s3Client = null;
function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: s3Region,
      endpoint: s3Endpoint || undefined,
      credentials: { accessKeyId: s3AccessKeyId, secretAccessKey: s3SecretAccessKey },
      forcePathStyle: s3ForcePathStyle,
    });
  }
  return s3Client;
}
// Tests substitute the client.
function setS3ClientForTests(client) { s3Client = client; }

// The driver a stored row was written with. Rows from before drivers were recorded are local files.
const driverOf = (driver) => (driver === 's3' ? 's3' : 'local');

function generateKey(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

// skipSizeLimit: for files the server makes itself (call recordings), not user uploads.
function validateFile(file, { skipSizeLimit = false } = {}) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw Object.assign(new Error(`Files of type "${ext}" are not allowed.`), { status: 400, expose: true });
  }
  if (!skipSizeLimit && file.size > MAX_FILE_SIZE) {
    throw Object.assign(new Error(`File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit.`), { status: 413, expose: true });
  }
}

// ------------------------------------------------------------------ writing
async function uploadFileLocal(file, key) {
  const destPath = path.join(LOCAL_UPLOAD_ROOT, key);
  if (!fs.existsSync(LOCAL_UPLOAD_ROOT)) fs.mkdirSync(LOCAL_UPLOAD_ROOT, { recursive: true });
  await fs.promises.copyFile(file.path, destPath);
  await fs.promises.unlink(file.path);
  return { key, url: `/uploads/${key}`, driver: 'local' };
}

// A file on disk to the bucket. The length is given up front because a stream of unknown length is refused.
async function putFileToS3(filePath, key, { contentType, size } = {}) {
  const length = size ?? (await fs.promises.stat(filePath)).size;
  await getS3Client().send(new PutObjectCommand({
    Bucket: s3Bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: length,
    ContentType: contentType || 'application/octet-stream',
  }));
}

async function uploadFileS3(file, key) {
  await putFileToS3(file.path, key, { contentType: file.mimetype, size: file.size });
  await fs.promises.unlink(file.path);
  return { key, url: s3CdnUrl ? `${s3CdnUrl}/${key}` : null, driver: 's3' };
}

async function uploadFile(file, options = {}) {
  validateFile(file, options);
  const key = generateKey(file.originalname);
  return STORAGE_DRIVER === 's3' ? uploadFileS3(file, key) : uploadFileLocal(file, key);
}

// Small in-memory objects (profile photos).
async function writeObject(key, buffer, contentType) {
  await getS3Client().send(new PutObjectCommand({ Bucket: s3Bucket, Key: key, Body: buffer, ContentLength: buffer.length, ContentType: contentType || 'application/octet-stream' }));
}

// ------------------------------------------------------------------ reading
const isMissing = (e) => e && (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404);

async function readObject(key) {
  try {
    const out = await getS3Client().send(new GetObjectCommand({ Bucket: s3Bucket, Key: key }));
    const chunks = [];
    for await (const chunk of out.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

async function headObject(key) {
  try {
    return await getS3Client().send(new HeadObjectCommand({ Bucket: s3Bucket, Key: key }));
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

// Sends one stored file as a download. `driver` is the one recorded with the file.
async function serveStored(req, res, { key, driver, name }) {
  if (driverOf(driver) === 'local') {
    return res.download(path.join(LOCAL_UPLOAD_ROOT, key), name, (err) => {
      if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).render('error', { title: 'Not Found', message: 'This file is no longer available.' });
    });
  }
  if (s3CdnUrl) return res.redirect(`${s3CdnUrl}/${key}`);
  let out;
  try {
    out = await getS3Client().send(new GetObjectCommand({ Bucket: s3Bucket, Key: key, Range: req.headers.range || undefined }));
  } catch (e) {
    if (isMissing(e)) return res.status(404).render('error', { title: 'Not Found', message: 'This file is no longer available.' });
    if (e.$metadata?.httpStatusCode === 416) return res.status(416).end();
    console.error('S3 download failed:', e.message);
    return res.status(502).render('error', { title: 'File storage unavailable', message: 'The file could not be fetched from storage. Try again in a moment.' });
  }
  res.attachment(name);                                   // Content-Disposition with a safe, encoded name
  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', out.ContentType || 'application/octet-stream');
  if (out.ContentLength != null) res.set('Content-Length', String(out.ContentLength));
  if (out.ContentRange) { res.status(206); res.set('Content-Range', out.ContentRange); }
  const body = out.Body;
  res.on('close', () => { if (body.destroy) body.destroy(); });   // the viewer went away: stop reading
  body.on('error', (err) => { console.error('S3 stream failed:', err.message); res.destroy(err); });
  body.pipe(res);
}

// ------------------------------------------------------------------ deleting
async function deleteFile(key, driver) {
  if (driverOf(driver) === 's3') {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));
    return;
  }
  const filePath = path.join(LOCAL_UPLOAD_ROOT, key);
  if (fs.existsSync(filePath)) await fs.promises.unlink(filePath);
}

// ------------------------------------------------------------------ start-up check
// Writes, reads and deletes a small object, so a wrong bucket, key or endpoint is reported when the
// server starts and not when the first person attaches a file. Returns null when fine (or when the
// local driver is in use), otherwise the problem as text.
async function selfCheck() {
  if (STORAGE_DRIVER !== 's3') return null;
  const key = `.healthcheck/${crypto.randomBytes(6).toString('hex')}`;
  const probe = Buffer.from('novaconnect storage check');
  try {
    await writeObject(key, probe, 'text/plain');
    const back = await readObject(key);
    if (!back || !back.equals(probe)) return 'the test object read back different from what was written';
    await getS3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket, Key: key }));
    return null;
  } catch (e) {
    return `${e.name || 'Error'}: ${e.message}`;
  }
}

module.exports = {
  uploadFile, deleteFile, serveStored, readObject, writeObject, headObject, putFileToS3, selfCheck,
  driverOf, setS3ClientForTests,
  MAX_FILE_SIZE, STORAGE_DRIVER, LOCAL_UPLOAD_ROOT,
};
