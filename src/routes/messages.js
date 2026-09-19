const path = require('path');
const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hydrateMessages, hydrateOne } = require('../messageUtils');
const { emitToChannel, emitToConversation, emitToUser } = require('../realtime');
const { upload, uploadRoot } = require('../upload');

const router = createAsyncRouter();
router.use(requireAuth);

async function isTeamMember(teamId, userId) {
  return !!(await db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId));
}
async function loadChannelForUser(channelId, userId) {
  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return null;
  if (!(await isTeamMember(channel.team_id, userId))) return null;
  if (channel.is_private) {
    const inChannel = await db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
    if (!inChannel) return null;
  }
  return channel;
}
async function channelMemberIds(channel) {
  return channel.is_private
    ? (await db.prepare('SELECT user_id FROM channel_members WHERE channel_id = ?').all(channel.id)).map(r => r.user_id)
    : (await db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(channel.team_id)).map(r => r.user_id);
}

// Extracts @mentions from a freshly-posted message body and records an in-app notification
// for each mentioned member who is actually reachable (team/channel member), skipping the author.
async function recordMentions({ body, authorId, memberRows, channelId, conversationId, messageId }) {
  const mentioned = memberRows.filter(m => m.id !== authorId && body.includes(`@${m.full_name}`));
  for (const m of mentioned) {
    await db.prepare(`
      INSERT INTO notifications (user_id, type, actor_id, channel_id, conversation_id, message_id, body)
      VALUES (?, 'mention', ?, ?, ?, ?, ?)
    `).run(m.id, authorId, channelId || null, conversationId || null, messageId, body.slice(0, 200));
    emitToUser(m.id, 'notification:new', { channel_id: channelId || null, conversation_id: conversationId || null });
  }
}

router.get('/api/channels/:id/messages', async (req, res) => {
  const channel = await loadChannelForUser(req.params.id, req.session.user.id);
  if (!channel) return res.status(403).json({ error: 'You do not have access to this channel.' });

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? Number(req.query.before) : null;
  const rows = before
    ? await db.prepare(`
        SELECT * FROM messages WHERE channel_id = ? AND parent_message_id IS NULL AND id < ?
        ORDER BY id DESC LIMIT ?
      `).all(channel.id, before, limit)
    : await db.prepare(`
        SELECT * FROM messages WHERE channel_id = ? AND parent_message_id IS NULL
        ORDER BY id DESC LIMIT ?
      `).all(channel.id, limit);

  const messages = await hydrateMessages(rows.reverse(), req.session.user.id);
  res.json({ messages, has_more: rows.length === limit });
});

router.post('/api/channels/:id/messages', (req, res, next) => upload.single('file')(req, res, next), async (req, res) => {
  const channel = await loadChannelForUser(req.params.id, req.session.user.id);
  if (!channel) return res.status(403).json({ error: 'You do not have access to this channel.' });

  const body = (req.body.body || '').trim();
  if (!body && !req.file) return res.status(400).json({ error: 'Message cannot be empty.' });
  const parentId = req.body.parent_message_id ? Number(req.body.parent_message_id) : null;

  const row = await db.prepare(`
    INSERT INTO messages (channel_id, user_id, body, parent_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(channel.id, req.session.user.id, body, parentId, nowStr(), nowStr());

  if (req.file) {
    await db.prepare(`
      INSERT INTO attachments (message_id, filename, original_name, mime_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.session.user.id);
  }

  const memberIds = await channelMemberIds(channel);
  const memberRows = memberIds.length
    ? await db.prepare(`SELECT id, full_name FROM users WHERE id IN (${memberIds.map(() => '?').join(',')})`).all(...memberIds)
    : [];
  await recordMentions({ body, authorId: req.session.user.id, memberRows, channelId: channel.id, conversationId: null, messageId: row.id });

  const message = await hydrateOne(row, req.session.user.id);
  emitToChannel(channel.id, parentId ? 'thread:message' : 'message:new', message);
  res.status(201).json(message);
});

router.get('/api/messages/:id/thread', async (req, res) => {
  const parent = await db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Message not found.' });
  if (parent.channel_id) {
    const channel = await loadChannelForUser(parent.channel_id, req.session.user.id);
    if (!channel) return res.status(403).json({ error: 'You do not have access to this channel.' });
  } else {
    const inConvo = await db.prepare('SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?').get(parent.conversation_id, req.session.user.id);
    if (!inConvo) return res.status(403).json({ error: 'You do not have access to this conversation.' });
  }
  const replies = await db.prepare('SELECT * FROM messages WHERE parent_message_id = ? ORDER BY id ASC').all(parent.id);
  const [parentHydrated] = await hydrateMessages([parent], req.session.user.id);
  const repliesHydrated = await hydrateMessages(replies, req.session.user.id);
  res.json({ parent: parentHydrated, replies: repliesHydrated });
});

async function loadMessageWithAccess(id, userId) {
  const msg = await db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  if (!msg) return null;
  if (msg.channel_id) {
    const channel = await loadChannelForUser(msg.channel_id, userId);
    if (!channel) return null;
    return { msg, channel, conversation: null };
  }
  const inConvo = await db.prepare('SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?').get(msg.conversation_id, userId);
  if (!inConvo) return null;
  return { msg, channel: null, conversation: { id: msg.conversation_id } };
}

router.post('/api/messages/:id/reactions', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx) return res.status(404).json({ error: 'Message not found or inaccessible.' });
  const emoji = (req.body.emoji || '').trim();
  if (!emoji) return res.status(400).json({ error: 'Emoji is required.' });

  const existing = await db.prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(ctx.msg.id, req.session.user.id, emoji);
  if (existing) {
    await db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').run(ctx.msg.id, req.session.user.id, emoji);
  } else {
    await db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)').run(ctx.msg.id, req.session.user.id, emoji);
  }

  const message = await hydrateOne(ctx.msg, null);
  const event = 'reaction:update';
  if (ctx.channel) emitToChannel(ctx.channel.id, event, { message_id: ctx.msg.id, reactions: message.reactions, parent_message_id: ctx.msg.parent_message_id });
  else emitToConversation(ctx.conversation.id, event, { message_id: ctx.msg.id, reactions: message.reactions, parent_message_id: ctx.msg.parent_message_id });
  res.json({ reactions: message.reactions });
});

router.put('/api/messages/:id', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx) return res.status(404).json({ error: 'Message not found or inaccessible.' });
  if (ctx.msg.user_id !== req.session.user.id) return res.status(403).json({ error: 'You can only edit your own messages.' });

  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });

  const updated = await db.prepare(`
    UPDATE messages SET body = ?, edited = 1, updated_at = ? WHERE id = ? RETURNING *
  `).get(body, nowStr(), ctx.msg.id);
  const message = await hydrateOne(updated, req.session.user.id);
  const event = updated.parent_message_id ? 'thread:message:update' : 'message:update';
  if (ctx.channel) emitToChannel(ctx.channel.id, event, message);
  else emitToConversation(ctx.conversation.id, event, message);
  res.json(message);
});

router.delete('/api/messages/:id', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx) return res.status(404).json({ error: 'Message not found or inaccessible.' });

  let canDelete = ctx.msg.user_id === req.session.user.id || req.session.user.role === 'admin';
  if (!canDelete && ctx.channel) {
    const owner = await db.prepare(`SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ? AND role = 'owner'`).get(ctx.channel.team_id, req.session.user.id);
    canDelete = !!owner;
  }
  if (!canDelete) return res.status(403).json({ error: 'You can only delete your own messages.' });

  await db.prepare("UPDATE messages SET deleted = 1, body = '', updated_at = ? WHERE id = ?").run(nowStr(), ctx.msg.id);
  const payload = { id: ctx.msg.id, parent_message_id: ctx.msg.parent_message_id };
  const event = ctx.msg.parent_message_id ? 'thread:message:delete' : 'message:delete';
  if (ctx.channel) emitToChannel(ctx.channel.id, event, payload);
  else emitToConversation(ctx.conversation.id, event, payload);
  res.json({ ok: true });
});

router.get('/api/attachments/:id/download', async (req, res) => {
  const att = await db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).render('error', { title: 'Not Found', message: 'Attachment not found.' });
  const ctx = await loadMessageWithAccess(att.message_id, req.session.user.id);
  if (!ctx) return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this file.' });
  res.download(path.join(uploadRoot, att.filename), att.original_name);
});

module.exports = router;
