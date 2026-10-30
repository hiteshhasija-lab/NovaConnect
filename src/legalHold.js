// Legal hold (Admin and compliance): while a hold is active, the messages it covers can't be
// destroyed. Admins create and release holds at /admin/holds (routes/admin.js); the table is in
// migrations/1792700000000_legal-hold.js.
//
// What a hold covers:
//   person  — every message they wrote (channels and chats) and every message in a chat they are in
//   channel — every message in that channel, replies included
//   chat    — every message in that 1:1 or group chat
// What it does:
//   - message retention (src/retention.js) skips held messages, and a person's meeting-chat lines;
//   - deleting a held message still removes it for everyone, but a copy is kept for admins first
//     (preserveMessage), with its edit history and the list of its files, which stay stored;
//   - a channel, or a team with a channel, that holds held messages can't be deleted.
// Nobody is told they are on hold. Creating and releasing holds is in the audit log.
const { db, nowStr } = require('./db');

const SCOPES = { person: 'Person', channel: 'Channel', chat: 'Chat' };

// "Message `alias` is covered by an active hold", for use inside a WHERE clause. No bindings.
// (No '?' may appear in it: knex reads every one as a binding.)
function heldSql(alias = 'm') {
  return `EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL AND (
    (h.scope_type = 'channel' AND h.scope_id = ${alias}.channel_id)
    OR (h.scope_type = 'chat' AND h.scope_id = ${alias}.conversation_id)
    OR (h.scope_type = 'person' AND (h.scope_id = ${alias}.user_id
      OR EXISTS (SELECT 1 FROM dm_participants hp WHERE hp.conversation_id = ${alias}.conversation_id AND hp.user_id = h.scope_id)))))`;
}

// The active holds covering one message (ids), or [] when none does.
async function holdsFor(messageId) {
  const rows = await db.prepare(`
    SELECT h.id FROM messages m JOIN legal_holds h ON h.released_at IS NULL AND (
      (h.scope_type = 'channel' AND h.scope_id = m.channel_id)
      OR (h.scope_type = 'chat' AND h.scope_id = m.conversation_id)
      OR (h.scope_type = 'person' AND (h.scope_id = m.user_id
        OR EXISTS (SELECT 1 FROM dm_participants hp WHERE hp.conversation_id = m.conversation_id AND hp.user_id = h.scope_id))))
    WHERE m.id = ? ORDER BY h.id
  `).all(messageId);
  return rows.map(r => r.id);
}

// Keeps a copy of a held message before it is deleted: text, banner, edit history, files.
async function preserveMessage(msg, { holdIds, reason, byUserId, place }) {
  const edits = await db.prepare('SELECT body, metadata, replaced_at FROM message_edits WHERE message_id = ? ORDER BY id').all(msg.id);
  const files = await db.prepare('SELECT id, original_name, mime_type, size, COALESCE(storage_key, filename) AS key, storage_driver FROM attachments WHERE message_id = ? ORDER BY id').all(msg.id);
  const author = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(msg.user_id);
  await db.prepare(`
    INSERT INTO preserved_messages (message_id, hold_ids, author_id, author_name, channel_id, conversation_id, place, body, metadata, edits, attachments,
      message_created_at, reason, by_user_id, preserved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(msg.id, holdIds.join(','), msg.user_id, author?.full_name || null, msg.channel_id || null, msg.conversation_id || null, place || null,
    msg.body || '', msg.metadata || null, edits.length ? JSON.stringify(edits) : null, files.length ? JSON.stringify(files) : null,
    msg.created_at, reason, byUserId || null, nowStr());
}

// Why a channel or a team can't be deleted right now, or null when it can.
async function channelDeleteBlock(channelId) {
  const held = await db.prepare(`SELECT 1 FROM messages m WHERE m.channel_id = ? AND ${heldSql('m')} LIMIT 1`).get(channelId);
  return held ? 'This channel has messages on legal hold, so it can’t be deleted until the hold is released.' : null;
}
async function teamDeleteBlock(teamId) {
  const held = await db.prepare(`SELECT 1 FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.team_id = ? AND ${heldSql('m')} LIMIT 1`).get(teamId);
  return held ? 'This team has messages on legal hold, so it can’t be deleted until the hold is released.' : null;
}

// The admin form: { error } or { value: { name, reason, scope_type, scope_id } }.
function parseHold(body) {
  const b = body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (!name || name.length > 120) return { error: 'Give the hold a name (a case or matter) of up to 120 characters.' };
  if (reason.length > 1000) return { error: 'Keep the reason to 1000 characters.' };
  if (!SCOPES[b.scope_type]) return { error: 'Choose what to hold: a person, a channel or a chat.' };
  const id = Number(b.scope_type === 'person' ? b.person_id : b.scope_type === 'channel' ? b.channel_id : b.chat_id);
  if (!Number.isSafeInteger(id) || id < 1) return { error: `Choose the ${SCOPES[b.scope_type].toLowerCase()} to hold.` };
  return { value: { name, reason, scope_type: b.scope_type, scope_id: id } };
}

// What the hold names, as people read it ('Jane Doe (@jdoe)', 'Platform › #general', 'Chat: Ann, Bob'),
// or null when it doesn't exist.
async function scopeLabel(scopeType, scopeId) {
  if (scopeType === 'person') {
    const u = await db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(scopeId);
    return u ? `${u.full_name} (@${u.username})` : null;
  }
  if (scopeType === 'channel') {
    const c = await db.prepare('SELECT c.name, t.name AS team FROM channels c LEFT JOIN teams t ON t.id = c.team_id WHERE c.id = ?').get(scopeId);
    return c ? `${c.team || 'Team'} › #${c.name}` : null;
  }
  const people = await db.prepare(`SELECT u.full_name FROM dm_participants p JOIN users u ON u.id = p.user_id WHERE p.conversation_id = ? ORDER BY u.full_name`).all(scopeId);
  return people.length ? `Chat #${scopeId}: ${people.map(p => p.full_name).join(', ')}` : null;
}

// How many messages an active hold covers now.
async function coveredCount(hold) {
  const where = hold.scope_type === 'channel' ? 'm.channel_id = ?'
    : hold.scope_type === 'chat' ? 'm.conversation_id = ?'
      : '(m.user_id = ? OR EXISTS (SELECT 1 FROM dm_participants hp WHERE hp.conversation_id = m.conversation_id AND hp.user_id = ?))';
  const params = hold.scope_type === 'person' ? [hold.scope_id, hold.scope_id] : [hold.scope_id];
  return Number((await db.prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${where}`).get(...params)).c);
}

module.exports = { SCOPES, heldSql, holdsFor, preserveMessage, channelDeleteBlock, teamDeleteBlock, parseHold, scopeLabel, coveredCount };
