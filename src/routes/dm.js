const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hydrateMessages, hydrateOne } = require('../messageUtils');
const { emitToConversation, resyncUserRooms } = require('../realtime');
const { upload } = require('../upload');

const router = createAsyncRouter();
router.use(requireAuth);

// Lists the user's DM/group-DM conversations for the sidebar, each with the other
// participant(s) and a preview of the most recent message.
router.get('/api/dm', async (req, res) => {
  const userId = req.session.user.id;
  const convos = await db.prepare(`
    SELECT dc.* FROM dm_conversations dc
    JOIN dm_participants dp ON dp.conversation_id = dc.id AND dp.user_id = ?
    ORDER BY dc.id DESC
  `).all(userId);

  const result = [];
  for (const c of convos) {
    const others = await db.prepare(`
      SELECT u.id, u.full_name, u.username, u.status FROM dm_participants dp
      JOIN users u ON u.id = dp.user_id WHERE dp.conversation_id = ? AND dp.user_id != ?
    `).all(c.id, userId);
    const last = await db.prepare(`
      SELECT m.*, u.full_name AS author_name FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? AND m.parent_message_id IS NULL ORDER BY m.id DESC LIMIT 1
    `).get(c.id);
    result.push({ ...c, participants: others, last_message: last || null });
  }
  res.json(result);
});

// Starts (or reuses) a DM. `user_ids` is the set of *other* participants — one id for a
// 1:1, several for a group DM. A 1:1 with an existing conversation is returned, not duplicated.
router.post('/api/dm', async (req, res) => {
  const userId = req.session.user.id;
  const otherIds = [...new Set((req.body.user_ids || []).map(Number).filter(id => id && id !== userId))];
  if (otherIds.length === 0) return res.status(400).json({ error: 'Pick at least one other person to message.' });

  if (otherIds.length === 1) {
    const existing = await db.prepare(`
      SELECT dc.id FROM dm_conversations dc
      JOIN dm_participants a ON a.conversation_id = dc.id AND a.user_id = ?
      JOIN dm_participants b ON b.conversation_id = dc.id AND b.user_id = ?
      WHERE dc.is_group = 0
      AND (SELECT COUNT(*) FROM dm_participants WHERE conversation_id = dc.id) = 2
    `).get(userId, otherIds[0]);
    if (existing) return res.json({ id: existing.id });
  }

  const isGroup = otherIds.length > 1 ? 1 : 0;
  const name = isGroup ? (req.body.name || null) : null;
  const convo = await db.prepare(`INSERT INTO dm_conversations (is_group, name, created_by) VALUES (?, ?, ?) RETURNING *`)
    .get(isGroup, name, userId);
  for (const uid of [userId, ...otherIds]) {
    await db.prepare('INSERT INTO dm_participants (conversation_id, user_id) VALUES (?, ?)').run(convo.id, uid);
    await resyncUserRooms(uid);
  }
  res.status(201).json({ id: convo.id });
});

async function loadConversationForUser(conversationId, userId) {
  const inConvo = await db.prepare('SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
  if (!inConvo) return null;
  return db.prepare('SELECT * FROM dm_conversations WHERE id = ?').get(conversationId);
}

router.get('/api/dm/:id', async (req, res) => {
  const convo = await loadConversationForUser(req.params.id, req.session.user.id);
  if (!convo) return res.status(403).json({ error: 'You are not part of this conversation.' });
  const participants = await db.prepare(`
    SELECT u.id, u.full_name, u.username, u.status FROM dm_participants dp JOIN users u ON u.id = dp.user_id
    WHERE dp.conversation_id = ? ORDER BY u.full_name
  `).all(convo.id);
  res.json({ conversation: convo, participants });
});

router.get('/api/dm/:id/messages', async (req, res) => {
  const convo = await loadConversationForUser(req.params.id, req.session.user.id);
  if (!convo) return res.status(403).json({ error: 'You are not part of this conversation.' });

  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before ? Number(req.query.before) : null;
  const rows = before
    ? await db.prepare(`
        SELECT * FROM messages WHERE conversation_id = ? AND parent_message_id IS NULL AND id < ?
        ORDER BY id DESC LIMIT ?
      `).all(convo.id, before, limit)
    : await db.prepare(`
        SELECT * FROM messages WHERE conversation_id = ? AND parent_message_id IS NULL
        ORDER BY id DESC LIMIT ?
      `).all(convo.id, limit);

  const messages = await hydrateMessages(rows.reverse(), req.session.user.id);
  res.json({ messages, has_more: rows.length === limit });
});

router.post('/api/dm/:id/messages', (req, res, next) => upload.single('file')(req, res, next), async (req, res) => {
  const convo = await loadConversationForUser(req.params.id, req.session.user.id);
  if (!convo) return res.status(403).json({ error: 'You are not part of this conversation.' });

  const body = (req.body.body || '').trim();
  if (!body && !req.file) return res.status(400).json({ error: 'Message cannot be empty.' });
  const parentId = req.body.parent_message_id ? Number(req.body.parent_message_id) : null;

  const row = await db.prepare(`
    INSERT INTO messages (conversation_id, user_id, body, parent_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(convo.id, req.session.user.id, body, parentId, nowStr(), nowStr());

  if (req.file) {
    await db.prepare(`
      INSERT INTO attachments (message_id, filename, original_name, mime_type, size, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)
    `).run(row.id, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.session.user.id);
  }

  const message = await hydrateOne(row, req.session.user.id);
  emitToConversation(convo.id, parentId ? 'thread:message' : 'message:new', message);
  res.status(201).json(message);
});

module.exports = router;
