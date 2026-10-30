const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hydrateMessages, hydrateOne } = require('../messageUtils');
const { emitToChannel, emitToConversation, emitToUser } = require('../realtime');
const { parseAnnouncement, announcementOf, metadataOf } = require('../announcement');
const { editVersions } = require('../editHistory');
const { audit } = require('../audit');
const { deleteForEveryone } = require('../messageDelete');
const { upload } = require('../upload');
const { saveAttachment, storeUpload } = require('../attachments');
const fileVersions = require('../fileVersions');
const path = require('path');
const { handleDecomTrigger } = require('../decomFlow');
const { indexMessage, updateMessage } = require('../search');
const { serveStored, driverOf, readObject, LOCAL_UPLOAD_ROOT } = require('../storage');

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
  const parentId = req.body.parent_message_id ? Number(req.body.parent_message_id) : null;
  // An announcement (headline banner) is a top-level post; its text under the banner may be empty.
  const announcement = parseAnnouncement({ headline: req.body.announcement_headline, subhead: req.body.announcement_subhead, theme: req.body.announcement_theme });
  if (announcement?.error) return res.status(400).json({ error: announcement.error });
  if (announcement && parentId) return res.status(400).json({ error: 'A reply cannot be an announcement.' });
  if (!body && !req.file && !gifUrl && !announcement) return res.status(400).json({ error: 'Message cannot be empty.' });
  const meta = { ...(gifUrl ? { gifUrl } : {}), ...(announcement ? { announcement: announcement.value } : {}) };
  const metadata = Object.keys(meta).length ? JSON.stringify(meta) : null;

  const row = await db.prepare(`
    INSERT INTO messages (channel_id, user_id, body, parent_message_id, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(channel.id, req.session.user.id, body, parentId, metadata, nowStr(), nowStr());

  if (req.file) {
    try {
      await saveAttachment(req.file, row.id, req.session.user.id);
    } catch (e) {
      // The message was saved a moment ago: take it back, so a failed upload leaves no empty message behind.
      await db.prepare('DELETE FROM messages WHERE id = ?').run(row.id);
      await require('fs').promises.unlink(req.file.path).catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error('Saving an attachment failed:', e.message);
      return res.status(502).json({ error: 'File storage is unavailable. Try again in a moment.' });
    }
  }

  const memberIds = await channelMemberIds(channel);
  const memberRows = memberIds.length
    ? await db.prepare(`SELECT id, full_name FROM users WHERE id IN (${memberIds.map(() => '?').join(',')})`).all(...memberIds)
    : [];
  await recordMentions({ body, authorId: req.session.user.id, memberRows, channelId: channel.id, conversationId: null, messageId: row.id });

  const message = await hydrateOne(row, req.session.user.id);
  emitToChannel(channel.id, parentId ? 'thread:message' : 'message:new', message);
  res.status(201).json(message);

  const author = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.session.user.id);
  const team = channel.team_id ? await db.prepare('SELECT id FROM teams WHERE id = ?').get(channel.team_id) : null;
  indexMessage(row, author, channel, null, team).catch(() => {});

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

  // The broadcast has no single viewer, so `mine` is false in it; each reaction lists `user_ids`
  // and the client works out its own. The toggler's answer is built for them.
  const message = await hydrateOne(ctx.msg, null);
  const event = 'reaction:update';
  if (ctx.channel) emitToChannel(ctx.channel.id, event, { message_id: ctx.msg.id, reactions: message.reactions, parent_message_id: ctx.msg.parent_message_id });
  else emitToConversation(ctx.conversation.id, event, { message_id: ctx.msg.id, reactions: message.reactions, parent_message_id: ctx.msg.parent_message_id });
  res.json({ reactions: (await hydrateOne(ctx.msg, req.session.user.id)).reactions });
});

router.put('/api/messages/:id', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx) return res.status(404).json({ error: 'Message not found or inaccessible.' });
  if (ctx.msg.user_id !== req.session.user.id) return res.status(403).json({ error: 'You can only edit your own messages.' });

  const body = (req.body.body || '').trim();
  // An announcement's headline, subheading and colour can be edited too (never added or removed).
  const existing = announcementOf(ctx.msg);
  let metadata = ctx.msg.metadata;
  if (req.body.announcement !== undefined) {
    if (!existing) return res.status(400).json({ error: 'Only an announcement has a headline.' });
    const a = parseAnnouncement(req.body.announcement);
    if (!a) return res.status(400).json({ error: 'An announcement needs a headline.' });
    if (a.error) return res.status(400).json({ error: a.error });
    metadata = JSON.stringify({ ...metadataOf(ctx.msg), announcement: a.value });
  }
  if (!body && !existing) return res.status(400).json({ error: 'Message cannot be empty.' });
  // Saving it unchanged is not an edit: no "(edited)", no history entry.
  if (body === ctx.msg.body && metadata === ctx.msg.metadata) return res.json(await hydrateOne(ctx.msg, req.session.user.id));

  // Keep the version being replaced (edit history), read under a row lock so two edits at once each
  // keep the version they really replaced.
  const updated = await db.transaction(async (trx) => {
    const now = nowStr();
    const current = (await trx.raw('SELECT body, metadata FROM messages WHERE id = ? FOR UPDATE', [ctx.msg.id])).rows[0];
    await trx('message_edits').insert({ message_id: ctx.msg.id, body: current.body || '', metadata: current.metadata, replaced_at: now });
    const [row] = await trx('messages').where({ id: ctx.msg.id }).update({ body, metadata, edited: 1, updated_at: now }).returning('*');
    return row;
  });
  const message = await hydrateOne(updated, req.session.user.id);
  const event = updated.parent_message_id ? 'thread:message:update' : 'message:update';
  if (ctx.channel) emitToChannel(ctx.channel.id, event, message);
  else emitToConversation(ctx.conversation.id, event, message);
  res.json(message);

  const author = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.session.user.id);
  const team = ctx.channel?.team_id ? await db.prepare('SELECT id FROM teams WHERE id = ?').get(ctx.channel.team_id) : null;
  updateMessage(updated, author, ctx.channel, ctx.conversation, team).catch(() => {});
});

// Edit history ("(edited)" opens it): every version, newest first, for anyone who can see the message.
router.get('/api/messages/:id/history', async (req, res) => {
  const ctx = await loadMessageWithAccess(req.params.id, req.session.user.id);
  if (!ctx || ctx.msg.deleted) return res.status(404).json({ error: 'Message not found or inaccessible.' });
  const edits = await db.prepare('SELECT body, metadata, replaced_at FROM message_edits WHERE message_id = ? ORDER BY id').all(ctx.msg.id);
  res.json({ versions: editVersions(ctx.msg, edits), untracked: !!Number(ctx.msg.edits_untracked) });
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

  const place = ctx.channel ? '#' + ctx.channel.name : 'chat #' + ctx.conversation.id;
  const holdIds = await deleteForEveryone(ctx.msg, { byUserId: req.session.user.id, place });
  // Who deleted which message where; not its text. by_moderator: an admin or team owner removed someone else's.
  await audit(req, 'message.delete', {
    targetType: 'message', targetId: ctx.msg.id, targetName: place,
    details: { author_id: ctx.msg.user_id, by_moderator: ctx.msg.user_id !== req.session.user.id, reply: !!ctx.msg.parent_message_id, ...(holdIds.length ? { preserved_for_holds: holdIds.join(',') } : {}) },
  });
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
  // A forwarded announcement arrives as an ordinary message: its headline (bold) and subheading lead the text.
  const ann = announcementOf(ctx.msg);
  const body = ann ? [`**${ann.headline}**`, ann.subhead, ctx.msg.body].filter(Boolean).join('\n') : ctx.msg.body;
  const row = await db.prepare(`
    INSERT INTO messages (channel_id, conversation_id, user_id, body, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(targetChannelId || null, targetChannelId ? null : targetConversationId, req.session.user.id, body, metadata, nowStr(), nowStr());

  const sourceAttachments = await db.prepare('SELECT * FROM attachments WHERE message_id = ?').all(ctx.msg.id);
  for (const a of sourceAttachments) {
    await db.prepare(`
      INSERT INTO attachments (message_id, filename, original_name, mime_type, size, uploaded_by, storage_driver, storage_key,
        thumb_key, thumb_driver, thumb_mime, image_width, image_height, thumb_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, a.filename, a.original_name, a.mime_type, a.size, req.session.user.id, a.storage_driver, a.storage_key,
      a.thumb_key, a.thumb_driver, a.thumb_mime, a.image_width, a.image_height, a.thumb_state);
  }

  if (targetConversationId) {
    await db.prepare('UPDATE dm_participants SET is_hidden = 0, is_unread = CASE WHEN user_id = ? THEN 0 ELSE 1 END WHERE conversation_id = ?').run(req.session.user.id, targetConversationId);
  }

  const message = await hydrateOne(row, req.session.user.id);
  if (targetChannelId) emitToChannel(targetChannelId, 'message:new', message);
  else emitToConversation(targetConversationId, 'message:new', message);
  res.status(201).json(message);

  // Searchable like any new message (it wasn't indexed until the next restart's full reindex).
  const forwarder = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.session.user.id);
  const targetConvo = targetChannel ? null : await db.prepare('SELECT id, name FROM dm_conversations WHERE id = ?').get(targetConversationId);
  indexMessage(row, forwarder, targetChannel, targetConvo, targetChannel && targetChannel.team_id ? { id: targetChannel.team_id } : null).catch(() => {});
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
  // The driver recorded with the file decides where it is read from, whatever STORAGE_DRIVER says now.
  await serveStored(req, res, { key: att.storage_key || att.filename, driver: att.storage_driver, name: att.original_name });
});

// ---------------- file versions (src/fileVersions.js) ----------------
// Anyone who can see the message sees a file's versions and downloads any of them; whoever shared
// it (or an admin) puts up a new version or restores an old one, and everyone viewing sees the
// message update live.
async function attachmentWithAccess(req) {
  const att = await db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.id) || 0);
  if (!att) return { status: 404, error: 'File not found.' };
  const ctx = await loadMessageWithAccess(att.message_id, req.session.user.id);
  if (!ctx) return { status: 403, error: 'You cannot view this file.' };
  return { att, ctx };
}
async function announceFileChange(ctx, req) {
  const fresh = await db.prepare('SELECT * FROM messages WHERE id = ?').get(ctx.msg.id);
  const message = await hydrateOne(fresh, req.session.user.id);
  const event = fresh.parent_message_id ? 'thread:message:update' : 'message:update';
  if (ctx.channel) emitToChannel(ctx.channel.id, event, message); else emitToConversation(ctx.conversation.id, event, message);
}
const versionsAnswer = async (att, req) => ({ attachment: { id: att.id, version_no: att.version_no, can_change: fileVersions.canChange(att, req.session.user) }, versions: await fileVersions.listVersions(att) });
router.get('/api/attachments/:id/versions', async (req, res) => {
  const a = await attachmentWithAccess(req);
  if (a.error) return res.status(a.status).json({ error: a.error });
  res.json(await versionsAnswer(a.att, req));
});
router.post('/api/attachments/:id/versions', (req, res, next) => upload.single('file')(req, res, next), async (req, res) => {
  const drop = () => req.file && require('fs').promises.unlink(req.file.path).catch(() => {});
  const a = await attachmentWithAccess(req);
  if (a.error) { await drop(); return res.status(a.status).json({ error: a.error }); }
  if (!fileVersions.canChange(a.att, req.session.user)) { await drop(); return res.status(403).json({ error: 'Only the person who shared this file (or an admin) can put up a new version.' }); }
  if (a.ctx.msg.deleted) { await drop(); return res.status(400).json({ error: 'This message was deleted.' }); }
  if (!req.file) return res.status(400).json({ error: 'Choose the new version of the file.' });
  const kept = await db.prepare('SELECT COUNT(*) AS n FROM attachment_versions WHERE attachment_id = ?').get(a.att.id);
  if (Number(kept.n) >= fileVersions.MAX_VERSIONS - 1) { await drop(); return res.status(400).json({ error: `A file can have up to ${fileVersions.MAX_VERSIONS} versions.` }); }
  const comment = fileVersions.parseComment(req.body.comment);
  if (comment.error) { await drop(); return res.status(400).json({ error: comment.error }); }
  let stored;
  try { stored = await storeUpload(req.file); } catch (e) {
    await drop();
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('Saving a file version failed:', e.message);
    return res.status(502).json({ error: 'File storage is unavailable. Try again in a moment.' });
  }
  const row = await fileVersions.replaceCurrent(a.att.id, fileVersions.fromUpload(req.file, stored), { byUserId: req.session.user.id, comment: comment.value });
  await announceFileChange(a.ctx, req);
  res.status(201).json(await versionsAnswer(row, req));
});
router.get('/api/attachments/:id/versions/:no/download', async (req, res) => {
  const a = await attachmentWithAccess(req);
  if (a.error) return res.status(a.status).render('error', { title: 'Not Found', message: a.error });
  const no = Number(req.params.no);
  if (no === a.att.version_no) return res.redirect(`/api/attachments/${a.att.id}/download`);
  const v = await db.prepare('SELECT * FROM attachment_versions WHERE attachment_id = ? AND version_no = ?').get(a.att.id, Number.isSafeInteger(no) ? no : 0);
  if (!v) return res.status(404).render('error', { title: 'Not Found', message: 'That version does not exist.' });
  await serveStored(req, res, { key: v.storage_key || v.filename, driver: v.storage_driver, name: v.original_name });
});
// Restoring a version makes it the newest one (nothing is lost: the current one is kept as a version).
router.post('/api/attachments/:id/versions/:no/restore', async (req, res) => {
  const a = await attachmentWithAccess(req);
  if (a.error) return res.status(a.status).json({ error: a.error });
  if (!fileVersions.canChange(a.att, req.session.user)) return res.status(403).json({ error: 'Only the person who shared this file (or an admin) can restore a version.' });
  if (a.ctx.msg.deleted) return res.status(400).json({ error: 'This message was deleted.' });
  const v = await db.prepare('SELECT * FROM attachment_versions WHERE attachment_id = ? AND version_no = ?').get(a.att.id, Number(req.params.no) || 0);
  if (!v) return res.status(404).json({ error: 'That version does not exist.' });
  try {
    const row = await fileVersions.replaceCurrent(a.att.id, fileVersions.fromVersion(v), { byUserId: req.session.user.id, comment: `Restored version ${v.version_no}` });
    await announceFileChange(a.ctx, req);
    res.json(await versionsAnswer(row, req));
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// A picture's thumbnail (src/thumbnails.js), for whoever may see its message; the full file when it has
// none (so an <img> always shows something). Keys are unique per upload, so it may be cached for good.
router.get('/api/attachments/:id/thumbnail', async (req, res) => {
  const att = await db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!att) return res.status(404).json({ error: 'Attachment not found.' });
  const ctx = await loadMessageWithAccess(att.message_id, req.session.user.id);
  if (!ctx) return res.status(403).json({ error: 'You cannot view this file.' });
  if (!att.thumb_key) return res.redirect(`/api/attachments/${att.id}/download`);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.set('X-Content-Type-Options', 'nosniff');
  if (driverOf(att.thumb_driver) === 'local') {
    return res.sendFile(path.join(LOCAL_UPLOAD_ROOT, att.thumb_key), { headers: { 'Content-Type': att.thumb_mime } }, (err) => {
      if (err && !res.headersSent) res.redirect(`/api/attachments/${att.id}/download`);
    });
  }
  const buf = await readObject(att.thumb_key);
  if (!buf) return res.redirect(`/api/attachments/${att.id}/download`);
  res.type(att.thumb_mime).send(buf);
});

module.exports = router;
// Reused by scheduler.js when delivering a due scheduled channel message, so it doesn't
// have to reimplement mention-notification recording or channel-membership resolution.
module.exports.recordMentions = recordMentions;
module.exports.channelMemberIds = channelMemberIds;
