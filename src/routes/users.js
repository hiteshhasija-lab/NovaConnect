const createAsyncRouter = require('../asyncRouter');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = createAsyncRouter();
router.use(requireAuth);

router.get('/api/users/search', async (req, res) => {
  const q = `%${String(req.query.q || '').trim().slice(0, 200)}%`;
  const rows = await db.prepare(`
    SELECT id, full_name, username, email, title, status FROM users
    WHERE active = 1 AND id != ? AND (full_name ILIKE ? OR username ILIKE ? OR email ILIKE ?)
    ORDER BY full_name LIMIT 10
  `).all(req.session.user.id, q, q, q);
  res.json(rows);
});

router.get('/api/notifications', async (req, res) => {
  const rows = await db.prepare(`
    SELECT n.*, u.full_name AS actor_name, c.name AS channel_name, c.team_id
    FROM notifications n
    LEFT JOIN users u ON u.id = n.actor_id
    LEFT JOIN channels c ON c.id = n.channel_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30
  `).all(req.session.user.id);
  const unread = await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0').get(req.session.user.id);
  res.json({ notifications: rows, unread_count: Number(unread.c) });
});

router.post('/api/notifications/:id/read', async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  res.json({ ok: true });
});

router.post('/api/notifications/read-all', async (req, res) => {
  await db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.session.user.id);
  res.json({ ok: true });
});

module.exports = router;
