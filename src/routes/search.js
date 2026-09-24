// One search bar across messages, files, and people — the pieces already existed
// separately (per-DM search in dm.js, per-channel file browsing in membership.js, people
// search in users.js) but nothing combined them the way Teams' top search bar does.
const createAsyncRouter = require('../asyncRouter');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = createAsyncRouter();
router.use(requireAuth);

async function visibleScope(userId) {
  const channelIds = (await db.prepare(`
    SELECT c.id FROM channels c
    JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = ?
    WHERE c.is_private = 0
    UNION
    SELECT cm.channel_id AS id FROM channel_members cm WHERE cm.user_id = ?
  `).all(userId, userId)).map(r => r.id);
  const convoIds = (await db.prepare('SELECT conversation_id AS id FROM dm_participants WHERE user_id = ?').all(userId)).map(r => r.id);
  return { channelIds, convoIds };
}

router.get('/api/search', async (req, res) => {
  const userId = req.session.user.id;
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.json({ messages: [], files: [], people: [] });
  const { channelIds, convoIds } = await visibleScope(userId);

  async function unionAcrossScope(channelSql, convoSql, extraParam) {
    const parts = [], params = [];
    if (channelIds.length) { parts.push(channelSql(channelIds.length)); params.push(...channelIds, extraParam); }
    if (convoIds.length) { parts.push(convoSql(convoIds.length)); params.push(...convoIds, extraParam); }
    if (!parts.length) return [];
    return db.prepare(parts.join(' UNION ALL ') + ' ORDER BY created_at DESC LIMIT 25').all(...params);
  }

  const messages = await unionAcrossScope(
    n => `SELECT m.id, m.body, m.created_at, m.channel_id, m.conversation_id, u.full_name AS author_name, c.name AS channel_name, NULL AS dm_is_group
          FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN channels c ON c.id = m.channel_id
          WHERE m.deleted = 0 AND m.channel_id IN (${Array(n).fill('?').join(',')}) AND strpos(lower(m.body), lower(?)) > 0`,
    n => `SELECT m.id, m.body, m.created_at, m.channel_id, m.conversation_id, u.full_name AS author_name, NULL AS channel_name, dc.is_group AS dm_is_group
          FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
          WHERE m.deleted = 0 AND m.conversation_id IN (${Array(n).fill('?').join(',')}) AND strpos(lower(m.body), lower(?)) > 0`,
    q
  );

  const files = await unionAcrossScope(
    n => `SELECT a.id, a.original_name, a.mime_type, a.created_at, m.channel_id, m.conversation_id, c.name AS channel_name, NULL AS dm_is_group
          FROM attachments a JOIN messages m ON m.id = a.message_id LEFT JOIN channels c ON c.id = m.channel_id
          WHERE m.deleted = 0 AND m.channel_id IN (${Array(n).fill('?').join(',')}) AND strpos(lower(a.original_name), lower(?)) > 0`,
    n => `SELECT a.id, a.original_name, a.mime_type, a.created_at, m.channel_id, m.conversation_id, NULL AS channel_name, dc.is_group AS dm_is_group
          FROM attachments a JOIN messages m ON m.id = a.message_id LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
          WHERE m.deleted = 0 AND m.conversation_id IN (${Array(n).fill('?').join(',')}) AND strpos(lower(a.original_name), lower(?)) > 0`,
    q
  );

  const like = `%${q}%`;
  const people = await db.prepare(`
    SELECT id, full_name, username, email, title, status FROM users
    WHERE active = 1 AND id != ? AND (full_name ILIKE ? OR username ILIKE ? OR email ILIKE ?)
      AND id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = ?)
      AND id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = ?)
    ORDER BY full_name LIMIT 10
  `).all(userId, like, like, like, userId, userId);

  res.json({ messages, files, people });
});

module.exports = router;
