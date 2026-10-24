const createAsyncRouter = require('../asyncRouter');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { normalizeNewUser, validateNewUser, usernameTaken, createUser } = require('../newUser');
const bcrypt = require('bcryptjs');
const { validateNewPassword } = require('../passwordChange');
const { revokeUserSessions } = require('../sessions');
const { disconnectUser } = require('../realtime');
const { audit, ACTIONS, GROUPS, auditFilters, auditCsv } = require('../audit');
const retention = require('../retention');
const { removeMessages } = require('../search');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

router.get('/reports', async (req, res) => {
  const reports = await db.prepare(`SELECT r.*, u.full_name AS reporter FROM chat_reports r JOIN users u ON u.id = r.reported_by ORDER BY r.id DESC LIMIT 200`).all();
  res.render('admin-reports', { title: 'Chat concerns', reports });
});

function listUsers() {
  return db.prepare(`
    SELECT id, username, full_name, email, title, role, status, active, must_change_password, created_at FROM users ORDER BY full_name
  `).all();
}

router.get('/users', async (req, res) => {
  const added = typeof req.query.added === 'string' ? req.query.added : null;
  const passwordReset = typeof req.query.password_reset === 'string' ? req.query.password_reset : null;
  res.render('admin-users', { title: 'Manage Users', users: await listUsers(), added, passwordReset, error: null, form: {} });
});

router.post('/users', async (req, res) => {
  const u = normalizeNewUser(req.body);
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  const form = { full_name: u.full_name, username: u.username, email: u.email, title: u.title, role };

  const error = validateNewUser(u) || ((await usernameTaken(u.username)) ? 'That username is already taken.' : null);
  if (error) {
    return res.status(400).render('admin-users', { title: 'Manage Users', users: await listUsers(), added: null, passwordReset: null, error, form });
  }

  await createUser(u, role);
  const created = await db.prepare('SELECT id FROM users WHERE username = ?').get(u.username);
  await audit(req, 'admin.user_create', { targetType: 'user', targetId: created?.id, targetName: u.username, details: { role } });
  res.redirect(`/admin/users?added=${encodeURIComponent(u.username)}`);
});

router.post('/users/:id/toggle-active', async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).render('error', { title: 'Not Allowed', message: 'You cannot deactivate your own account.' });
  }
  const target = await db.prepare('UPDATE users SET active = 1 - active WHERE id = ? RETURNING id, username, active').get(req.params.id);
  if (target) await audit(req, target.active ? 'admin.user_activate' : 'admin.user_deactivate', { targetType: 'user', targetId: target.id, targetName: target.username });
  res.redirect('/admin/users');
});

router.post('/users/:id/role', async (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  const before = await db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(req.params.id);
  await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (before && before.role !== role) await audit(req, 'admin.role_change', { targetType: 'user', targetId: before.id, targetName: before.username, details: { from: before.role, to: role } });
  res.redirect('/admin/users');
});

router.post('/users/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id === req.session.user.id) {
    return res.status(400).render('error', { title: 'Not Allowed', message: 'Choose another user account to reset.' });
  }
  const user = await db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).render('error', { title: 'Not Found', message: 'That user no longer exists.' });
  const validationError = validateNewPassword(req.body.new_password, req.body.confirm_password);
  if (validationError) return res.status(400).render('error', { title: 'Password Not Reset', message: validationError });

  const passwordHash = await bcrypt.hash(req.body.new_password, 10);
  await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(passwordHash, id);
  // Whoever held the old password (or a session made with it) is signed out everywhere.
  await revokeUserSessions(id);
  disconnectUser(id);
  await audit(req, 'admin.password_reset', { targetType: 'user', targetId: id, targetName: user.username });
  res.redirect(`/admin/users?password_reset=${encodeURIComponent(user.username)}`);
});

// ---------------- audit log ----------------
// 'key: value · key: value' for the Details column (the JSON kept in the row, never message text).
function detailsText(raw) {
  if (!raw) return '';
  try { return Object.entries(JSON.parse(raw)).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v === null ? 'none' : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · '); } catch { return raw; }
}
const AUDIT_PAGE = 100;
router.get('/audit', async (req, res) => {
  const f = auditFilters(req.query);
  const rows = await db.prepare(`SELECT * FROM audit_log ${f.sql} ORDER BY id DESC LIMIT ${AUDIT_PAGE}`).all(...f.params);
  rows.forEach(r => { r.detailsText = detailsText(r.details); });
  const keep = new URLSearchParams(Object.entries(f.applied).map(([k, v]) => [k, String(v)]));
  const olderLink = rows.length === AUDIT_PAGE ? `/admin/audit?${new URLSearchParams([...keep, ['before', String(rows[rows.length - 1].id)]])}` : null;
  const people = await db.prepare('SELECT id, full_name, username FROM users ORDER BY full_name').all();
  res.render('admin-audit', { title: 'Audit log', rows, people, groups: GROUPS, actions: ACTIONS, applied: f.applied, query: keep.toString(), olderLink });
});
router.get('/audit.csv', async (req, res) => {
  const f = auditFilters({ ...req.query, before: undefined });
  const rows = await db.prepare(`SELECT * FROM audit_log ${f.sql} ORDER BY id DESC LIMIT 50000`).all(...f.params);
  await audit(req, 'audit.export', { details: { entries: rows.length, ...f.applied } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="novaconnect-audit-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(auditCsv(rows));
});

// ---------------- message retention ----------------
const retentionLabel = (days) => {
  if (!days) return 'Keep forever';
  if (days % 365 === 0) return days === 365 ? '1 year' : `${days / 365} years`;
  return days === 180 ? '6 months' : `${days} days`;
};
async function renderRetention(res, { notice = null, error = null, confirm = null, status = 200 } = {}) {
  res.status(status).render('admin-retention', {
    title: 'Message retention', policy: await retention.getPolicy(), options: retention.RETENTION_OPTIONS, label: retentionLabel, notice, error, confirm,
  });
}
router.get('/retention', async (req, res) => renderRetention(res));
// Two steps: the first submit shows what the new policy deletes right now; "Save" (confirm=1) saves.
router.post('/retention', async (req, res) => {
  const parsed = retention.parsePolicy(req.body);
  if (parsed.error) return renderRetention(res, { error: parsed.error, status: 400 });
  const before = await retention.getPolicy();
  if (before.channel_days === parsed.value.channel_days && before.chat_days === parsed.value.chat_days) return renderRetention(res, { notice: 'Nothing changed.' });
  if (req.body.confirm !== '1') return renderRetention(res, { confirm: { value: parsed.value, preview: await retention.preview(parsed.value) } });
  await retention.setPolicy(parsed.value, req.session.user.id);
  await audit(req, 'retention.policy', { details: {
    channels_from: retentionLabel(before.channel_days), channels_to: retentionLabel(parsed.value.channel_days),
    chats_from: retentionLabel(before.chat_days), chats_to: retentionLabel(parsed.value.chat_days),
  } });
  renderRetention(res, { notice: 'Retention policy saved. Messages past it are deleted within the hour (or now, with Run now).' });
});
router.post('/retention/run', async (req, res) => {
  const r = await retention.runRetention({ unindex: ids => removeMessages(ids).catch(e => console.error('retention: search index cleanup failed:', e.message)) });
  if (!r.ran) return renderRetention(res, { error: 'No retention policy is set, so there is nothing to delete.', status: 400 });
  const counts = retention.summary(r);
  if (retention.removedSomething(r)) await audit(req, 'retention.run', { details: { ...counts, run_by_admin: true } });
  if (req.accepts(['html', 'json']) === 'json') return res.json(counts);
  const deleted = counts.channel_deleted + counts.channel_cleared + counts.chat_deleted + counts.chat_cleared + counts.meeting_chat_deleted;
  renderRetention(res, { notice: deleted ? `Deleted ${deleted} message(s) and ${counts.files_deleted} file(s) past the policy.` : 'Nothing was past the policy.' });
});

module.exports = router;
