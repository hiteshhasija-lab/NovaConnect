const createAsyncRouter = require('../asyncRouter');
const { db } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = createAsyncRouter();
router.use(requireAuth, requireRole('admin'));

router.get('/users', async (req, res) => {
  const users = await db.prepare(`
    SELECT id, username, full_name, email, title, role, status, active, created_at FROM users ORDER BY full_name
  `).all();
  res.render('admin-users', { title: 'Manage Users', users });
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
