const { db } = require('../db');
const { loginDestination } = require('../loginDestination');

async function requireAuth(req, res, next) {
  if (!req.session.user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in.' });
    const destination = req.method === 'GET' && loginDestination(req.originalUrl);
    if (destination) req.session.returnTo = destination;
    return res.redirect('/login');
  }

  const fresh = await db.prepare('SELECT id, username, full_name, role, active FROM users WHERE id = ?').get(req.session.user.id);
  if (!fresh || !fresh.active) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  req.session.user.role = fresh.role;
  req.session.user.full_name = fresh.full_name;
  req.session.user.username = fresh.username;

  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'You do not have permission to do that.' });
      return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to view this page.' });
    }
    next();
  };
}

function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  next();
}

module.exports = { requireAuth, requireRole, attachUser };
