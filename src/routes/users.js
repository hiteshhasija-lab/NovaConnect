const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { outOfOfficeSummary, isOutOfOffice, parseOutOfOffice } = require('../presenceRules');
const { touchPresence, emitToUser } = require('../realtime');

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

// Out of office (the avatar menu's "Schedule out of office" dialog): on/off, a message, an optional
// window. While it's on, people see "Out of office" as your status (presenceRules.js), and the
// message on your profile card and above the composer when they write to you.
const oooSettings = (row) => ({
  enabled: !!Number(row.ooo_enabled), message: row.ooo_message || '', start_at: row.ooo_start_at, end_at: row.ooo_end_at,
  active: isOutOfOffice(row, nowStr())
});
router.get('/api/profile/out-of-office', async (req, res) => {
  const row = await db.prepare('SELECT ooo_enabled, ooo_message, ooo_start_at, ooo_end_at FROM users WHERE id = ?').get(req.session.user.id);
  res.json(oooSettings(row));
});
router.put('/api/profile/out-of-office', async (req, res) => {
  const parsed = parseOutOfOffice(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  const row = await db.prepare(`
    UPDATE users SET ooo_enabled = ?, ooo_message = ?, ooo_start_at = ?, ooo_end_at = ? WHERE id = ?
    RETURNING ooo_enabled, ooo_message, ooo_start_at, ooo_end_at
  `).get(v.ooo_enabled, v.ooo_message, v.ooo_start_at, v.ooo_end_at, req.session.user.id);
  touchPresence(req.session.user.id);
  res.json(oooSettings(row));
});

// VIP people (the avatar menu's "VIP people" and each profile card's star): your own list of people
// whose messages always reach you (public/js/vip-rules.js). Private: nobody else sees it, and the
// person added is not told. Your other tabs and devices hear 'vips:changed'.
const VIP_MAX = 50;
const vipList = (userId) => db.prepare(`
  SELECT u.id, u.full_name, u.username, u.title FROM vip_people v JOIN users u ON u.id = v.vip_id
  WHERE v.user_id = ? AND u.active = 1 ORDER BY u.full_name
`).all(userId);
router.get('/api/profile/vips', async (req, res) => res.json(await vipList(req.session.user.id)));
router.put('/api/profile/vips/:userId', async (req, res) => {
  const me = req.session.user.id, vipId = Number(req.params.userId);
  if (!Number.isSafeInteger(vipId) || vipId === me) return res.status(400).json({ error: 'Choose someone else.' });
  const person = await db.prepare(`
    SELECT id FROM users WHERE id = ? AND active = 1
      AND id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = ?)
      AND id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = ?)
  `).get(vipId, me, me);
  if (!person) return res.status(404).json({ error: 'Person not found.' });
  const count = await db.prepare('SELECT COUNT(*) AS c FROM vip_people WHERE user_id = ?').get(me);
  const already = await db.prepare('SELECT 1 FROM vip_people WHERE user_id = ? AND vip_id = ?').get(me, vipId);
  if (!already && Number(count.c) >= VIP_MAX) return res.status(400).json({ error: `You can have up to ${VIP_MAX} VIP people.` });
  await db.prepare('INSERT INTO vip_people (user_id, vip_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(me, vipId, nowStr());
  const list = await vipList(me);
  emitToUser(me, 'vips:changed', { ids: list.map(v => v.id) });
  res.json(list);
});
router.delete('/api/profile/vips/:userId', async (req, res) => {
  const me = req.session.user.id;
  await db.prepare('DELETE FROM vip_people WHERE user_id = ? AND vip_id = ?').run(me, Number(req.params.userId) || 0);
  const list = await vipList(me);
  emitToUser(me, 'vips:changed', { ids: list.map(v => v.id) });
  res.json(list);
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
    SELECT id, full_name, username, email, title, status, status_message, status_message_expires_at,
      ooo_enabled, ooo_message, ooo_start_at, ooo_end_at FROM users WHERE id = ? AND active = 1
  `).get(targetId);
  if (!user) return res.status(404).json({ error: 'Person not found.' });
  if (user.status_message_expires_at && user.status_message_expires_at < nowStr()) {
    user.status_message = null;
  }
  user.out_of_office = outOfOfficeSummary(user, nowStr());
  for (const k of ['status_message_expires_at', 'ooo_enabled', 'ooo_message', 'ooo_start_at', 'ooo_end_at']) delete user[k];
  res.json(user);
});

router.get('/api/notifications', async (req, res) => {
  const rows = await db.prepare(`
    SELECT n.*, u.full_name AS actor_name, c.name AS channel_name, t.name AS team_name,
      (n.type = 'team_join_request' AND EXISTS (SELECT 1 FROM team_join_requests jr WHERE jr.team_id = n.team_id AND jr.user_id = n.actor_id)) AS request_pending
    FROM notifications n
    LEFT JOIN users u ON u.id = n.actor_id
    LEFT JOIN channels c ON c.id = n.channel_id
    LEFT JOIN teams t ON t.id = n.team_id
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
