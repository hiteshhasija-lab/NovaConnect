// A message's uploaded file: its thumbnail when it is a picture (src/thumbnails.js), the file itself
// (src/storage.js), and the attachments row. Shared by channel and chat posts, so both behave alike.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { db } = require('./db');
const { uploadFile, storeBuffer, readObject, driverOf, LOCAL_UPLOAD_ROOT } = require('./storage');
const { makeThumbnail } = require('./thumbnails');

// Stores a thumbnail (from makeThumbnail) next to `storedKey`; the columns to save.
async function storeThumbnail(thumb, storedKey) {
  if (!thumb) return { thumb_state: 'none' };
  const key = `${storedKey}.thumb.${thumb.mime === 'image/webp' ? 'webp' : 'jpg'}`;
  try {
    const driver = await storeBuffer(key, thumb.buffer, thumb.mime);
    return { thumb_key: key, thumb_driver: driver, thumb_mime: thumb.mime, image_width: thumb.width, image_height: thumb.height, thumb_state: 'done' };
  } catch (e) {
    console.error('storing a thumbnail failed:', e.message);
    return { thumb_state: 'none' };
  }
}
const thumbnailColumns = async (source, storedKey) => storeThumbnail(await makeThumbnail(source), storedKey);

// An uploaded file stored, with its thumbnail when it is a picture: { stored, t } (t: thumbnail columns).
// Throws what uploadFile throws. The thumbnail is made from the temporary file first (uploading moves
// it away); for a file that isn't a picture that is a 16-byte read.
async function storeUpload(file) {
  const thumb = await makeThumbnail(file.path);
  const stored = await uploadFile(file);
  return { stored, t: await storeThumbnail(thumb, stored.key) };
}

// A new message's file. Throws what uploadFile throws (the route turns it into its answer).
async function saveAttachment(file, messageId, userId) {
  const { stored, t } = await storeUpload(file);
  await db.prepare(`
    INSERT INTO attachments (message_id, filename, original_name, mime_type, size, uploaded_by, storage_driver, storage_key,
      thumb_key, thumb_driver, thumb_mime, image_width, image_height, thumb_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(messageId, stored.key, file.originalname, file.mimetype, file.size, userId, stored.driver, stored.key,
    t.thumb_key || null, t.thumb_driver || null, t.thumb_mime || null, t.image_width || null, t.image_height || null, t.thumb_state);
}

// Pictures uploaded before thumbnails existed (thumb_state NULL) get one, a few at a time, once,
// after start-up. A file that is gone or unreadable is marked 'none' and not tried again.
async function backfillThumbnails({ batch = 20 } = {}) {
  let made = 0;
  for (;;) {
    const rows = await db.prepare(`
      SELECT id, COALESCE(storage_key, filename) AS key, storage_driver FROM attachments
      WHERE thumb_state IS NULL AND mime_type LIKE 'image/%' ORDER BY id LIMIT ${batch}
    `).all();
    if (!rows.length) break;
    for (const a of rows) {
      let source = null, temp = null;
      try {
        if (driverOf(a.storage_driver) === 'local') source = path.join(LOCAL_UPLOAD_ROOT, a.key);
        else {
          const buf = await readObject(a.key);
          if (buf) { temp = path.join(os.tmpdir(), `nc-src-${crypto.randomBytes(6).toString('hex')}`); await fs.promises.writeFile(temp, buf); source = temp; }
        }
        const t = source && fs.existsSync(source) ? await thumbnailColumns(source, a.key) : { thumb_state: 'none' };
        await db.prepare(`UPDATE attachments SET thumb_key = ?, thumb_driver = ?, thumb_mime = ?, image_width = ?, image_height = ?, thumb_state = ? WHERE id = ?`)
          .run(t.thumb_key || null, t.thumb_driver || null, t.thumb_mime || null, t.image_width || null, t.image_height || null, t.thumb_state, a.id);
        if (t.thumb_state === 'done') made++;
      } catch (e) {
        console.error('thumbnail backfill: attachment', a.id, e.message);
        await db.prepare(`UPDATE attachments SET thumb_state = 'none' WHERE id = ?`).run(a.id).catch(() => {});
      } finally {
        if (temp) await fs.promises.unlink(temp).catch(() => {});
      }
    }
  }
  return made;
}

module.exports = { saveAttachment, storeUpload, backfillThumbnails };
