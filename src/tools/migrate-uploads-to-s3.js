// Moves the files saved before STORAGE_DRIVER=s3 into the bucket.
//
//   node src/tools/migrate-uploads-to-s3.js                          dry run: what would move
//   node src/tools/migrate-uploads-to-s3.js --apply                  copy, verify the size in the bucket, switch the rows to s3
//   node src/tools/migrate-uploads-to-s3.js --apply --delete-local   ... and remove each local copy once it is verified
//
// Run it where the app runs (it needs the same database and S3_* settings), for example:
//   podman exec novaconnect-api node src/tools/migrate-uploads-to-s3.js --apply
// Safe to run again and to interrupt: a file is switched to s3 only after the copy in the bucket has
// the right size, and files already in the bucket are skipped. Without --delete-local nothing local
// is removed, so the old files stay as a fallback until you delete them yourself.
const fs = require('fs');
const path = require('path');

async function migrate({ db, storage, root, apply = false, deleteLocal = false, log = console.log }) {
  const out = { files: 0, bytes: 0, moved: 0, cleaned: 0, missing: [], errors: [], photos: 0 };

  // ---- attachments and recordings: rows still marked local, grouped by stored file
  const keys = new Map();     // key -> { contentType, tables:Set }
  const addKey = (key, contentType, table) => {
    if (!key) return;
    const entry = keys.get(key) || { contentType, tables: new Set() };
    entry.tables.add(table);
    keys.set(key, entry);
  };
  for (const r of await db.prepare("SELECT DISTINCT storage_key, mime_type FROM attachments WHERE storage_driver = 'local' AND storage_key IS NOT NULL").all()) addKey(r.storage_key, r.mime_type, 'attachments');
  for (const r of await db.prepare("SELECT DISTINCT storage_key FROM recordings WHERE storage_driver = 'local' AND storage_key IS NOT NULL").all()) addKey(r.storage_key, 'video/mp4', 'recordings');

  for (const [key, entry] of keys) {
    const file = path.join(root, key);
    let stat;
    try { stat = await fs.promises.stat(file); } catch { out.missing.push(key); continue; }
    out.files++; out.bytes += stat.size;
    if (!apply) continue;
    try {
      const existing = await storage.headObject(key);
      if (!existing || existing.ContentLength !== stat.size) {
        await storage.putFileToS3(file, key, { contentType: entry.contentType, size: stat.size });
        const check = await storage.headObject(key);
        if (!check || check.ContentLength !== stat.size) throw new Error(`size in the bucket (${check ? check.ContentLength : 'missing'}) differs from the file (${stat.size})`);
      }
      for (const table of entry.tables) await db.prepare(`UPDATE ${table} SET storage_driver = 's3' WHERE storage_key = ? AND storage_driver = 'local'`).run(key);
      if (deleteLocal) await fs.promises.unlink(file);
      out.moved++;
    } catch (e) {
      out.errors.push(`${key}: ${e.message}`);
    }
  }

  // ---- --delete-local on a later run: files already switched to s3 (an earlier run without the flag)
  // whose local copy is still there. Removed only if the bucket holds a copy of the same size.
  if (apply && deleteLocal) {
    const switched = new Set();
    for (const table of ['attachments', 'recordings']) {
      for (const r of await db.prepare(`SELECT DISTINCT storage_key FROM ${table} WHERE storage_driver = 's3' AND storage_key IS NOT NULL`).all()) switched.add(r.storage_key);
    }
    let entries = [];
    try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { /* no folder */ }
    for (const entry of entries) {
      if (!entry.isFile() || !switched.has(entry.name)) continue;
      const file = path.join(root, entry.name);
      try {
        const size = (await fs.promises.stat(file)).size;
        const inBucket = await storage.headObject(entry.name);
        if (inBucket && inBucket.ContentLength === size) { await fs.promises.unlink(file); out.cleaned++; }
        else out.errors.push(`${entry.name}: the local copy was kept because the bucket does not hold an identical one`);
      } catch (e) { out.errors.push(`${entry.name}: ${e.message}`); }
    }
  }

  // ---- profile photos: files named by user id in profile-photos/
  const photoDir = path.join(root, 'profile-photos');
  let names = [];
  try { names = await fs.promises.readdir(photoDir); } catch { /* none */ }
  const { photoType } = require('../profilePhoto');
  for (const name of names.filter((n) => /^\d+$/.test(n))) {
    const file = path.join(photoDir, name);
    const data = await fs.promises.readFile(file);
    const type = photoType(data);
    if (!type) continue;
    out.photos++;
    if (!apply) continue;
    try {
      await storage.writeObject(`profile-photos/${name}`, data, type);
      const check = await storage.headObject(`profile-photos/${name}`);
      if (!check || check.ContentLength !== data.length) throw new Error('size in the bucket differs');
      if (deleteLocal) await fs.promises.unlink(file);
    } catch (e) {
      out.errors.push(`profile photo ${name}: ${e.message}`);
    }
  }

  const mb = (out.bytes / 1024 / 1024).toFixed(1);
  log(`${apply ? 'Moved' : 'Would move'}: ${apply ? out.moved : out.files} of ${out.files} files (${mb} MB) and ${out.photos} profile photos.`);
  if (out.cleaned) log(`Removed ${out.cleaned} local copies that were already in the bucket.`);
  if (out.missing.length) log(`Not on disk (left as they are): ${out.missing.length}${out.missing.length <= 5 ? ' - ' + out.missing.join(', ') : ''}`);
  if (out.errors.length) log(`Errors (${out.errors.length}):\n  ${out.errors.join('\n  ')}`);
  if (!apply) log('Dry run. Add --apply to copy and switch.');
  return out;
}

module.exports = { migrate };

if (require.main === module) {
  (async () => {
    const storage = require('../storage');
    if (storage.STORAGE_DRIVER !== 's3') { console.error('STORAGE_DRIVER is not s3 here: set it and the S3_* settings first.'); process.exit(2); }
    const problem = await storage.selfCheck();
    if (problem) { console.error('The bucket is not usable: ' + problem); process.exit(2); }
    const { db } = require('../db');
    const apply = process.argv.includes('--apply');
    const result = await migrate({ db, storage, root: storage.LOCAL_UPLOAD_ROOT, apply, deleteLocal: process.argv.includes('--delete-local') });
    process.exit(result.errors.length ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
