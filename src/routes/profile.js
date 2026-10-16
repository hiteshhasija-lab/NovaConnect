const bcrypt = require('bcryptjs');
const createAsyncRouter = require('../asyncRouter');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateNewPassword, replacePassword } = require('../passwordChange');

const router = createAsyncRouter();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { title: 'My Profile', user, error: null, success: null });
});

router.post('/', async (req, res) => {
  const { full_name, email, title, status_message } = req.body;
  if (!full_name || !full_name.trim()) {
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
    return res.render('profile', { title: 'My Profile', user, error: 'Full name is required.', success: null });
  }
  await db.prepare(`
    UPDATE users SET full_name = ?, email = ?, title = ?, status_message = ? WHERE id = ?
  `).run(full_name.trim(), email || null, title || null, status_message || null, req.session.user.id);
  req.session.user.full_name = full_name.trim();

  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('profile', { title: 'My Profile', user, error: null, success: 'Profile updated.' });
});

router.post('/password', async (req, res) => {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const { current_password, new_password, confirm_password } = req.body;

  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.render('profile', { title: 'My Profile', user, error: 'Current password is incorrect.', success: null });
  }
  const validationError = validateNewPassword(new_password, confirm_password);
  if (validationError) return res.render('profile', { title: 'My Profile', user, error: validationError, success: null });

  await replacePassword(db, user.id, new_password);
  req.session.user.must_change_password = false;
  user.must_change_password = 0;
  res.render('profile', { title: 'My Profile', user, error: null, success: 'Password changed.' });
});

module.exports = router;
