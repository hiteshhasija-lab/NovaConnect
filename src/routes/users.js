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
      AND id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = ?)
      AND id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = ?)
    ORDER BY full_name LIMIT 10
  `).all(req.session.user.id, q, q, q, req.session.user.id, req.session.user.id);
  res.json(rows);
});

router.get('/api/users/blocked', async (req, res) => {
  const rows = await db.prepare(`
    SELECT u.id, u.full_name, u.username FROM blocked_users b JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ? ORDER BY u.full_name
  `).all(req.session.user.id);
  res.json(rows);
});

router.post('/api/users/:id/block', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId) || targetId === req.session.user.id) return res.status(400).json({ error: 'Invalid person to block.' });
  const target = await db.prepare('SELECT id, full_name FROM users WHERE id = ? AND active = 1').get(targetId);
  if (!target) return res.status(404).json({ error: 'Person not found.' });
  await db.prepare('INSERT INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT (blocker_id, blocked_id) DO NOTHING').run(req.session.user.id, targetId);
  res.json({ ok: true, full_name: target.full_name });
});

router.delete('/api/users/:id/block', async (req, res) => {
  await db.prepare('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?').run(req.session.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// Quick status-message setter (the avatar dropdown popover) — separate from the full
// /profile page form, same shape as Teams' own "Set status message" flyout: a message plus
// a "clear after" duration. Expiry is computed here (server clock, naive UTC, matching every
// other timestamp in this app) and actually cleared later by scheduler.js's poll tick rather
// than just hidden client-side, so every consumer (profile card, DM header, etc.) sees the
// same true state without each having to re-check expiry itself.
function computeStatusExpiry(clearAfter) {
  const now = new Date();
  switch (clearAfter) {
    case 'today': { const d = new Date(now); d.setUTCHours(23, 59, 59, 999); return d; }
    case '1h': return new Date(now.getTime() + 60 * 60000);
    case '4h': return new Date(now.getTime() + 4 * 60 * 60000);
    case 'week': return new Date(now.getTime() + 7 * 86400000);
    default: return null;
  }
}

router.patch('/api/profile/status-message', async (req, res) => {
  const statusMessage = String(req.body.status_message || '').trim().slice(0, 280) || null;
  const clearAfter = ['today', '1h', '4h', 'week'].includes(req.body.clear_after) ? req.body.clear_after : 'never';
  const expiry = statusMessage ? computeStatusExpiry(clearAfter) : null;
  const expiresAt = expiry ? expiry.toISOString().slice(0, 19).replace('T', ' ') : null;
  await db.prepare('UPDATE users SET status_message = ?, status_message_expires_at = ? WHERE id = ?')
    .run(statusMessage, expiresAt, req.session.user.id);
  res.json({ status_message: statusMessage, status_message_expires_at: expiresAt });
});

// Full profile-card payload — used when clicking someone's avatar/name anywhere in the app.
router.get('/api/users/:id/profile', async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isSafeInteger(targetId)) return res.status(400).json({ error: 'Invalid user.' });
  const blocked = await db.prepare(`
    SELECT 1 FROM blocked_users WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `).get(req.session.user.id, targetId, targetId, req.session.user.id);
  if (blocked) return res.status(404).json({ error: 'Person not found.' });
  const user = await db.prepare(`
    SELECT id, full_name, username, email, title, status, status_message, status_message_expires_at FROM users WHERE id = ? AND active = 1
  `).get(targetId);
  if (!user) return res.status(404).json({ error: 'Person not found.' });
  if (user.status_message_expires_at && user.status_message_expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    user.status_message = null;
  }
  delete user.status_message_expires_at;
  res.json(user);
});

router.get('/api/notifications', async (req, res) => {
  const rows = await db.prepare(`
    SELECT n.*, u.full_name AS actor_name, c.name AS channel_name
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
