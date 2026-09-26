const bcrypt = require('bcryptjs');
const { loginDestination } = require('../loginDestination');
const { db } = require('../db');
const { normalizeNewUser, validateNewUser, createUser } = require('../newUser');
const createAsyncRouter = require('../asyncRouter');

const router = createAsyncRouter();

router.get('/', (req, res) => {
  res.redirect(req.session.user ? '/app' : '/login');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  res.render('login', { error: null, title: 'Log In' });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'Invalid username or password.', title: 'Log In' });
  }
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  if (req.body.remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
  const dest = loginDestination(req.session.returnTo) || '/app';
  delete req.session.returnTo;
  res.redirect(dest);
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/app');
  res.render('register', { error: null, title: 'Create Account', form: {} });
});

router.post('/register', async (req, res) => {
  const b = normalizeNewUser(req.body);
  const form = { full_name: b.full_name, username: b.username, email: b.email, title: b.title };

  const error = validateNewUser(b);
  if (error) return res.render('register', { error, title: 'Create Account', form });

  try {
    await createUser(b);
  } catch (e) {
    return res.render('register', { error: 'That username is already taken.', title: 'Create Account', form });
  }

  const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(b.username);
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  res.redirect('/app');
});

router.post('/logout', async (req, res) => {
  const userId = req.session.user && req.session.user.id;
  req.session.destroy(async () => {
    if (userId) await db.prepare("UPDATE users SET status = 'offline' WHERE id = ?").run(userId);
    res.redirect('/login');
  });
});

module.exports = router;
