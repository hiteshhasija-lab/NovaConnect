const path = require('path');
const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hydrateMessages, hydrateOne } = require('../messageUtils');
const { emitToChannel, emitToConversation, emitToUser } = require('../realtime');
const { upload, uploadRoot } = require('../upload');
const { handleDecomTrigger } = require('../decomFlow');

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

// Accepts only the app's naive-UTC 'YYYY-MM-DD HH:MM:SS' shape (the client converts its
// datetime-local input's browser-local value with localInputToUtcStr before sending, same
// helper the calendar event form already uses) at least a minute out, so scheduling "now"
// can't race the scheduler's own poll interval into firing immediately.
function parseSendAt(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return null;
  const minFuture = new Date(Date.now() + 60000).toISOString().slice(0, 19).replace('T', ' ');
  return raw > minFuture ? raw : null;
}

router.get('/api/scheduled-messages', async (req, res) => {
  const rows = await db.prepare(`
    SELECT sm.*, c.name AS channel_name, dc.is_group AS dm_is_group
    FROM scheduled_messages sm
    LEFT JOIN channels c ON c.id = sm.channel_id
    LEFT JOIN dm_conversations dc ON dc.id = sm.conversation_id
    WHERE sm.user_id = ? AND sm.status = 'pending' ORDER BY sm.send_at
  `).all(req.session.user.id);
  res.json(rows);
});

router.delete('/api/scheduled-messages/:id', async (req, res) => {
  const row = await db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(req.params.id);
  if (!row || row.user_id !== req.session.user.id) return res.status(404).json({ error: 'Scheduled message not found.' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'This message has already been sent or cancelled.' });
  await db.prepare(`UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

router.post('/api/channels/:id/messages/schedule', async (req, res) => {
  const channel = await loadChannelForUser(req.params.id, req.session.user.id);
  if (!channel) return res.status(403).json({ error: 'You do not have access to this channel.' });
  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const sendAt = parseSendAt(req.body.send_at);
  if (!sendAt) return res.status(400).json({ error: 'Choose a time at least a minute in the future.' });
  const parentId = req.body.parent_message_id ? Number(req.body.parent_message_id) : null;
  const row = await db.prepare(`
    INSERT INTO scheduled_messages (channel_id, user_id, body, parent_message_id, send_at) VALUES (?, ?, ?, ?, ?) RETURNING *
  `).get(channel.id, req.session.user.id, body, parentId, sendAt);
  res.status(201).json(row);
});

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

// A GIF picker selection is sent as a message with no text body, just this URL — restricted
// to https so it can never become a javascript:/data: URI in the <img src> the client renders.
function parseGifUrl(raw) {
  return typeof raw === 'string' && /^https:\/\//.test(raw) ? raw : null;
}

router.post('/api/channels/:id/messages', (req, res, next) => upload.single('file')(req, res, next), async (req, res) => {
  const channel = await loadChannelForUser(req.params.id, req.session.user.id);
  if (!channel) return res.status(403).json({ error: 'You do not have access to this channel.' });

  const body = (req.body.body || '').trim();
  const gifUrl = parseGifUrl(req.body.gif_url);
  if (!body && !req.file && !gifUrl) return res.status(400).json({ error: 'Message cannot be empty.' });
  const parentId = req.body.parent_message_id ? Number(req.body.parent_message_id) : null;
  const metadata = gifUrl ? JSON.stringify({ gifUrl }) : null;

  const row = await db.prepare(`
    INSERT INTO messages (channel_id, user_id, body, parent_message_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(channel.id, req.session.user.id, body, parentId, metadata, nowStr(), nowStr());

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

  if (channel.name === 'server-decom' && !parentId && body) {
    handleDecomTrigger({ channelId: channel.id }, req.session.user.id, body).catch(() => {});
  }
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

router.post('/api/messages/:id/pin', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx) return res.status(404).json({ error: 'Message not found or inaccessible.' });
  if (ctx.msg.deleted) return res.status(400).json({ error: 'This message was deleted.' });

  const nowPinned = !ctx.msg.pinned_at;
  const updated = await db.prepare(`
    UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ? RETURNING *
  `).get(nowPinned ? nowStr() : null, nowPinned ? req.session.user.id : null, ctx.msg.id);

  const message = await hydrateOne(updated, req.session.user.id);
  const event = updated.parent_message_id ? 'thread:message:update' : 'message:update';
  if (ctx.channel) emitToChannel(ctx.channel.id, event, message);
  else emitToConversation(ctx.conversation.id, event, message);
  res.json(message);
});

// Lists every currently-pinned message in a channel or DM, newest pin first — used by the
// "Pinned messages" panel in both chat headers.
router.get('/api/pins', async (req, res) => {
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  const conversationId = req.query.conversation_id ? Number(req.query.conversation_id) : null;
  if (!channelId && !conversationId) return res.status(400).json({ error: 'channel_id or conversation_id is required.' });

  if (channelId) {
    const channel = await loadChannelForUser(channelId, req.session.user.id);
    if (!channel) return res.status(403).json({ error: 'You do not have access to this channel.' });
  } else {
    const inConvo = await db.prepare('SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?').get(conversationId, req.session.user.id);
    if (!inConvo) return res.status(403).json({ error: 'You are not part of this conversation.' });
  }

  const rows = await db.prepare(`
    SELECT * FROM messages WHERE ${channelId ? 'channel_id = ?' : 'conversation_id = ?'} AND pinned_at IS NOT NULL AND deleted = 0
    ORDER BY pinned_at DESC
  `).all(channelId || conversationId);
  res.json(await hydrateMessages(rows, req.session.user.id));
});

// Copies a message's text (and any attachments, by referencing the same stored file — no
// re-upload needed) into another channel or DM the user has access to, tagged with where it
// came from so the recipient's client can render a "Forwarded from X" note.
router.post('/api/messages/:id/forward', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx || ctx.msg.deleted) return res.status(404).json({ error: 'Message not found or inaccessible.' });

  const targetChannelId = req.body.channel_id ? Number(req.body.channel_id) : null;
  const targetConversationId = req.body.conversation_id ? Number(req.body.conversation_id) : null;
  if (!targetChannelId && !targetConversationId) return res.status(400).json({ error: 'Choose where to forward this message.' });

  let targetChannel = null;
  if (targetChannelId) {
    targetChannel = await loadChannelForUser(targetChannelId, req.session.user.id);
    if (!targetChannel) return res.status(403).json({ error: 'You do not have access to that channel.' });
  } else {
    const inConvo = await db.prepare('SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?').get(targetConversationId, req.session.user.id);
    if (!inConvo) return res.status(403).json({ error: 'You are not part of that conversation.' });
  }

  const author = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(ctx.msg.user_id);
  const metadata = JSON.stringify({ forwardedFrom: { messageId: ctx.msg.id, authorName: author ? author.full_name : 'Unknown user' } });
  const row = await db.prepare(`
    INSERT INTO messages (channel_id, conversation_id, user_id, body, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(targetChannelId || null, targetChannelId ? null : targetConversationId, req.session.user.id, ctx.msg.body, metadata, nowStr(), nowStr());

  const sourceAttachments = await db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(ctx.msg.id);
  for (const a of sourceAttachments) {
    await db.prepare(`
      INSERT INTO attachments (message_id, filename, original_name, mime_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, a.filename, a.original_name, a.mime_type, a.size, req.session.user.id);
  }

  if (targetConversationId) {
    await db.prepare('UPDATE dm_participants SET is_hidden = 0, is_unread = CASE WHEN user_id = ? THEN 0 ELSE 1 END WHERE conversation_id = ?').run(req.session.user.id, targetConversationId);
  }

  const message = await hydrateOne(row, req.session.user.id);
  if (targetChannelId) emitToChannel(targetChannelId, 'message:new', message);
  else emitToConversation(targetConversationId, 'message:new', message);
  res.status(201).json(message);
});

// No GOOGLE_TRANSLATE_API_KEY set yet — mirrors ai.js's own placeholder-until-configured
// pattern rather than erroring, so the button always exists but is honest about its state.
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';

router.post('/api/messages/:id/translate', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx || ctx.msg.deleted) return res.status(404).json({ error: 'Message not found or inaccessible.' });
  if (!ctx.msg.body.trim()) return res.status(400).json({ error: 'Nothing to translate.' });

  if (!GOOGLE_TRANSLATE_API_KEY) {
    return res.json({ configured: false, note: "Translation isn't set up yet — ask your admin to add a GOOGLE_TRANSLATE_API_KEY." });
  }

  const target = /^[a-z]{2}(-[A-Z]{2})?$/.test(req.body.target || '') ? req.body.target : 'en';
  try {
    const resp = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + GOOGLE_TRANSLATE_API_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: ctx.msg.body, target })
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Google Translate API error ${resp.status}: ${errText.slice(0, 300)}`);
    }
    const data = await resp.json();
    const result = data.data.translations[0];
    res.json({ configured: true, translated: result.translatedText, detectedLang: result.detectedSourceLanguage, target });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the translation service.' });
  }
});

router.get('/api/attachments/:id/download', async (req, res) => {
  const att = await db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).render('error', { title: 'Not Found', message: 'Attachment not found.' });
  const ctx = await loadMessageWithAccess(att.message_id, req.session.user.id);
  if (!ctx) return res.status(403).render('error', { title: 'Access Denied', message: 'You cannot view this file.' });
  res.download(path.join(uploadRoot, att.filename), att.original_name);
});

module.exports = router;
// Reused by scheduler.js when delivering a due scheduled channel message, so it doesn't
// have to reimplement mention-notification recording or channel-membership resolution.
module.exports.recordMentions = recordMentions;
module.exports.channelMemberIds = channelMemberIds;
