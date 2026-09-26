const createAsyncRouter = require('../asyncRouter');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { normalizeNewUser, validateNewUser, usernameTaken, createUser } = require('../newUser');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

router.get('/reports', async (req, res) => {
  const reports = await db.prepare(`SELECT r.*, u.full_name AS reporter FROM chat_reports r JOIN users u ON u.id = r.reported_by ORDER BY r.id DESC LIMIT 200`).all();
  res.render('admin-reports', { title: 'Chat concerns', reports });
});

function listUsers() {
  return db.prepare(`
    SELECT id, username, full_name, email, title, role, status, active, created_at FROM users ORDER BY full_name
  `).all();
}

router.get('/users', async (req, res) => {
  const added = typeof req.query.added === 'string' ? req.query.added : null;
  res.render('admin-users', { title: 'Manage Users', users: await listUsers(), added, error: null, form: {} });
});

router.post('/users', async (req, res) => {
  const u = normalizeNewUser(req.body);
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  const form = { full_name: u.full_name, username: u.username, email: u.email, title: u.title, role };

  const error = validateNewUser(u) || ((await usernameTaken(u.username)) ? 'That username is already taken.' : null);
  if (error) {
    return res.status(400).render('admin-users', { title: 'Manage Users', users: await listUsers(), added: null, error, form });
  }

  await createUser(u, role);
  res.redirect(`/admin/users?added=${encodeURIComponent(u.username)}`);
});

router.post('/users/:id/toggle-active', async (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).render('error', { title: 'Not Allowed', message: 'You cannot deactivate your own account.' });
  }
  await db.prepare('UPDATE users SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/users');
});

router.post('/users/:id/role', async (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.redirect('/admin/users');
});

module.exports = router;
