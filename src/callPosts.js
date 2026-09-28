const { db, nowStr } = require('./db');
const { hydrateOne } = require('./messageUtils');
const { indexMessage } = require('./search');

// Messages a call puts into the chat or channel it belongs to: the in-call chat (so it's still
// there after the call, as in Teams), and call/meeting events ("Call ended · 5m", "Missed call",
// "Meeting ended"). scope is { type: 'dm' | 'channel', id }. Sent to everyone who can see the chat
// or channel the same way as a normal message (message:new / message:update).

const room = scope => (scope.type === 'channel' ? 'channel:' : 'dm:') + scope.id;

// attachment (optional): a stored file to attach, like a chat upload —
// { originalName, mimeType, size, storageDriver, storageKey } (e.g. a call recording).
async function postToScope(io, scope, userId, body, metadata = null, attachment = null) {
  const column = scope.type === 'channel' ? 'channel_id' : 'conversation_id';
  const row = await db.prepare(`INSERT INTO messages (${column}, user_id, body, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(scope.id, userId, body, metadata ? JSON.stringify(metadata) : null, nowStr(), nowStr());
  if (attachment) {
    await db.prepare(`INSERT INTO attachments (message_id, filename, original_name, mime_type, size, uploaded_by, storage_driver, storage_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, attachment.storageKey, attachment.originalName, attachment.mimeType, attachment.size, userId, attachment.storageDriver, attachment.storageKey);
  }
  // Like a normal chat message: brings a hidden chat back and marks it unread for everyone else.
  if (scope.type === 'dm') await db.prepare('UPDATE dm_participants SET is_hidden = 0, is_unread = CASE WHEN user_id = ? THEN 0 ELSE 1 END WHERE conversation_id = ?').run(userId, scope.id);
  const message = await hydrateOne(row, null);
  io.to(room(scope)).emit('message:new', message);
  const author = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
  indexMessage(row, author, null, null, null).catch(() => {});
  return message;
}

// Rewrites a call's own post in place (e.g. "Started a meeting" → "Meeting ended · 12m"),
// without the "(edited)" mark a user edit gets.
async function updatePost(io, scope, messageId, body, metadata = null) {
  const row = await db.prepare('UPDATE messages SET body = ?, metadata = ?, updated_at = ? WHERE id = ? RETURNING *')
    .get(body, metadata ? JSON.stringify(metadata) : null, nowStr(), messageId);
  if (!row) return null;
  const message = await hydrateOne(row, null);
  io.to(room(scope)).emit('message:update', message);
  return message;
}

// 45s, 5m 12s, 1h 5m
function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

module.exports = { postToScope, updatePost, formatDuration };
