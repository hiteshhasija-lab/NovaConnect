const { db } = require('./db');

function parseMetadata(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Attaches author, grouped reactions, attachments, and (for top-level messages) a thread
// reply count/last-reply time to a flat list of message rows, in the shape the chat UI expects.
async function hydrateMessages(rows, currentUserId) {
  if (rows.length === 0) return [];
  const ids = rows.map(r => r.id);

  const authorIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
  const authors = authorIds.length
    ? await db.prepare(`SELECT id, full_name, username, status FROM users WHERE id IN (${authorIds.map(() => '?').join(',')})`).all(...authorIds)
    : [];
  const authorById = Object.fromEntries(authors.map(a => [a.id, a]));

  const reactions = await db.prepare(`
    SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  const reactionsByMessage = {};
  for (const r of reactions) {
    if (!reactionsByMessage[r.message_id]) reactionsByMessage[r.message_id] = {};
    if (!reactionsByMessage[r.message_id][r.emoji]) reactionsByMessage[r.message_id][r.emoji] = { emoji: r.emoji, count: 0, mine: false };
    reactionsByMessage[r.message_id][r.emoji].count++;
    if (r.user_id === currentUserId) reactionsByMessage[r.message_id][r.emoji].mine = true;
  }

  const attachments = await db.prepare(`
    SELECT * FROM attachments WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id
  `).all(...ids);
  const attachmentsByMessage = {};
  for (const a of attachments) {
    (attachmentsByMessage[a.message_id] = attachmentsByMessage[a.message_id] || []).push(a);
  }

  const threadCounts = await db.prepare(`
    SELECT parent_message_id, COUNT(*) AS c, MAX(created_at) AS last_at
    FROM messages WHERE parent_message_id IN (${ids.map(() => '?').join(',')}) AND deleted = 0
    GROUP BY parent_message_id
  `).all(...ids);
  const threadByParent = Object.fromEntries(threadCounts.map(t => [t.parent_message_id, t]));

  return rows.map(r => ({
    id: r.id,
    channel_id: r.channel_id,
    conversation_id: r.conversation_id,
    parent_message_id: r.parent_message_id,
    body: r.body,
    metadata: parseMetadata(r.metadata),
    edited: !!r.edited,
    deleted: !!r.deleted,
    created_at: r.created_at,
    updated_at: r.updated_at,
    author: authorById[r.user_id] || { id: r.user_id, full_name: 'Unknown user', username: '' },
    reactions: Object.values(reactionsByMessage[r.id] || {}),
    attachments: attachmentsByMessage[r.id] || [],
    reply_count: threadByParent[r.id] ? Number(threadByParent[r.id].c) : 0,
    last_reply_at: threadByParent[r.id] ? threadByParent[r.id].last_at : null
  }));
}

async function hydrateOne(row, currentUserId) {
  const [msg] = await hydrateMessages([row], currentUserId);
  return msg;
}

module.exports = { hydrateMessages, hydrateOne };
