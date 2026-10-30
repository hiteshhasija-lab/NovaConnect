// File versions (Files): a file in a message replaced by a new version in place, by the person who
// shared it or an admin; every version it replaced stays downloadable and can be restored (which
// makes it the newest version again). routes/fileVersions.js serves it; the table is in
// migrations/1793000000000_file-versions.js. The attachments row is always the current version.
const { db, nowStr } = require('./db');

const MAX_VERSIONS = 50;
const COMMENT_MAX = 200;

// Who may put up a new version or restore an old one: whoever first shared the file, or an admin.
const canChange = (att, user) => !!user && (Number(att.uploaded_by) === Number(user.id) || user.role === 'admin');

function parseComment(raw) {
  const c = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return c.length > COMMENT_MAX ? { error: `Keep the note to ${COMMENT_MAX} characters.` } : { value: c || null };
}

// Makes `next` (the file columns of the new current version) current, keeping the one it replaces.
// Row-locked, so two uploads at once each keep what they really replaced. Returns the updated row.
async function replaceCurrent(attachmentId, next, { byUserId, comment }) {
  return db.transaction(async (trx) => {
    const cur = (await trx.raw('SELECT * FROM attachments WHERE id = ? FOR UPDATE', [attachmentId])).rows[0];
    if (!cur) return null;
    const kept = Number((await trx.raw('SELECT COUNT(*) AS n FROM attachment_versions WHERE attachment_id = ?', [attachmentId])).rows[0].n);
    if (kept >= MAX_VERSIONS - 1) { const e = new Error(`A file can have up to ${MAX_VERSIONS} versions.`); e.status = 400; throw e; }
    await trx('attachment_versions').insert({
      attachment_id: cur.id, version_no: cur.version_no, filename: cur.filename, storage_key: cur.storage_key, storage_driver: cur.storage_driver,
      original_name: cur.original_name, mime_type: cur.mime_type, size: cur.size,
      uploaded_by: cur.version_by || cur.uploaded_by, uploaded_at: cur.version_at || cur.created_at, comment: cur.version_comment,
      thumb_key: cur.thumb_key, thumb_driver: cur.thumb_driver, thumb_mime: cur.thumb_mime, image_width: cur.image_width, image_height: cur.image_height, thumb_state: cur.thumb_state,
    });
    const [row] = await trx('attachments').where({ id: cur.id }).update({
      filename: next.filename, storage_key: next.storage_key, storage_driver: next.storage_driver,
      original_name: next.original_name, mime_type: next.mime_type, size: next.size,
      thumb_key: next.thumb_key || null, thumb_driver: next.thumb_driver || null, thumb_mime: next.thumb_mime || null,
      image_width: next.image_width || null, image_height: next.image_height || null, thumb_state: next.thumb_state || 'none',
      version_no: cur.version_no + 1, version_comment: comment, version_by: byUserId, version_at: nowStr(),
    }).returning('*');
    return row;
  });
}

// The file columns of an uploaded version (storeUpload's answer) or of a kept version (to restore it).
const fromUpload = (file, { stored, t }) => ({
  filename: stored.key, storage_key: stored.key, storage_driver: stored.driver, original_name: file.originalname, mime_type: file.mimetype, size: file.size, ...t,
});
const fromVersion = (v) => ({
  filename: v.filename, storage_key: v.storage_key, storage_driver: v.storage_driver, original_name: v.original_name, mime_type: v.mime_type, size: v.size,
  thumb_key: v.thumb_key, thumb_driver: v.thumb_driver, thumb_mime: v.thumb_mime, image_width: v.image_width, image_height: v.image_height, thumb_state: v.thumb_state,
});

// Every version, newest (the current one) first.
async function listVersions(att) {
  const old = await db.prepare(`
    SELECT v.version_no, v.original_name, v.mime_type, v.size, v.uploaded_at, v.comment, u.full_name AS uploaded_by_name
    FROM attachment_versions v LEFT JOIN users u ON u.id = v.uploaded_by WHERE v.attachment_id = ? ORDER BY v.version_no DESC
  `).all(att.id);
  const by = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(att.version_by || att.uploaded_by);
  return [{
    version_no: att.version_no, original_name: att.original_name, mime_type: att.mime_type, size: att.size,
    uploaded_at: att.version_at || att.created_at, comment: att.version_comment, uploaded_by_name: by?.full_name || null, current: true,
  }, ...old.map(v => ({ ...v, current: false }))];
}

module.exports = { canChange, parseComment, replaceCurrent, fromUpload, fromVersion, listVersions, MAX_VERSIONS };
