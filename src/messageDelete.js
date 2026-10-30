// Deleting a message for everyone: by its author or a moderator (DELETE /api/messages/:id), or by an
// admin recalling it (/admin/recall). The text goes, "This message was deleted" (or "removed by an
// administrator") stays in its place, its edit history and search entry go, and everyone viewing
// hears it live. On legal hold (src/legalHold.js) a copy is kept for admins first.
const { db, nowStr } = require('./db');
const { emitToChannel, emitToConversation } = require('./realtime');
const { removeMessage } = require('./search');
const { holdsFor, preserveMessage } = require('./legalHold');

// msg: the messages row. Returns the ids of the holds that kept a copy ([] when none did).
async function deleteForEveryone(msg, { byUserId, place, recalled = false }) {
  const holdIds = msg.deleted ? [] : await holdsFor(msg.id);
  if (holdIds.length) await preserveMessage(msg, { holdIds, reason: recalled ? 'recalled' : 'deleted', byUserId, place });
  // A recalled message says so instead of "This message was deleted" (its other metadata goes).
  const metadata = recalled ? JSON.stringify({ recalled: true }) : msg.metadata;
  await db.prepare("UPDATE messages SET deleted = 1, body = '', metadata = ?, updated_at = ? WHERE id = ?").run(metadata, nowStr(), msg.id);
  // Its earlier versions go with it: a deleted message's text is not kept anywhere else either
  // (except the legal-hold copy above, which took them along).
  await db.prepare('DELETE FROM message_edits WHERE message_id = ?').run(msg.id);
  const payload = { id: msg.id, parent_message_id: msg.parent_message_id, ...(recalled ? { recalled: true } : {}) };
  const event = msg.parent_message_id ? 'thread:message:delete' : 'message:delete';
  if (msg.channel_id) emitToChannel(msg.channel_id, event, payload);
  else emitToConversation(msg.conversation_id, event, payload);
  removeMessage(msg.id).catch(() => {});
  return holdIds;
}

module.exports = { deleteForEveryone };
