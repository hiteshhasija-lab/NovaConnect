const bcrypt = require('bcryptjs');
const createAsyncRouter = require('./asyncRouter');
const { validateNewPassword, replacePassword } = require('./passwordChange');

// Same session and identity as the web app; never issue a second, weaker bearer token.
// audit: src/audit.js's writer (server.js passes it; tests leave the no-op).
function createMobileSessionRouter({ db, compare = bcrypt.compare, hash = bcrypt.hash, revokeOtherSessions = async () => {}, audit = async () => {} }) {
  const router = createAsyncRouter();
  const publicUser = u => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, status: u.status || 'offline', must_change_password: Boolean(u.must_change_password) });
  const regenerate = req => new Promise((resolve, reject) => req.session.regenerate(err => err ? reject(err) : resolve()));
  const save = req => new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password || username.length > 200 || password.length > 1024) {
      return res.status(400).json({ error: 'Enter a username and password.' });
    }
    const user = await db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username.trim());
    if (!user || !await compare(password, user.password_hash)) {
      await audit(req, 'auth.login_failed', { actor: null, targetType: 'user', targetId: user?.id, targetName: username.trim().slice(0, 100), details: { via: 'app', reason: user ? 'wrong password' : 'no active account with that username' } });
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    await regenerate(req);
    req.session.user = publicUser(user);
    req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
    await save(req);
    await audit(req, 'auth.login', { actor: user, details: { via: 'app' } });
    return res.json({ user: publicUser(user) });
  });
  router.get('/session', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not signed in.' });
    const user = await db.prepare('SELECT id, username, full_name, role, status, active, must_change_password FROM users WHERE id = ?').get(req.session.user.id);
    if (!user || !user.active) {
      await new Promise((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
      return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    }
    req.session.user = publicUser(user);
    return res.json({ user: publicUser(user) });
  });
  router.post('/password', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Not signed in.' });
    const user = await db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(req.session.user.id);
    if (!user || !await compare(req.body?.current_password || '', user.password_hash)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    const error = validateNewPassword(req.body?.new_password, req.body?.confirm_password);
    if (error) return res.status(400).json({ error });
    await replacePassword(db, user.id, req.body.new_password, hash);
    await revokeOtherSessions(user.id, req.sessionID);
    await audit(req, 'auth.password_change', { actor: user, details: { via: 'app', was_temporary: !!user.must_change_password } });
    user.must_change_password = 0;
    req.session.user = publicUser(user);
    await save(req);
    return res.json({ user: publicUser(user) });
  });
  router.post('/logout', async (req, res) => {
    if (req.session.user) await audit(req, 'auth.logout', { details: { via: 'app' } });
    await new Promise((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
    res.clearCookie('connect.sid');
    return res.json({ ok: true });
  });
  return router;
}
module.exports = { createMobileSessionRouter };
