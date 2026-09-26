const bcrypt = require('bcryptjs');
const { db } = require('./db');

// Shared by public sign-up and admin "Add user" so both enforce the same account rules.
function normalizeNewUser(body) {
  const trim = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    full_name: trim(body.full_name),
    username: trim(body.username),
    email: trim(body.email),
    title: trim(body.title),
    password: typeof body.password === 'string' ? body.password : '',
    confirm_password: typeof body.confirm_password === 'string' ? body.confirm_password : '',
  };
}

function validateNewUser(u) {
  if (!u.full_name || !u.username || !u.password) return 'Full name, username, and password are required.';
  if (u.password.length < 8) return 'Password must be at least 8 characters.';
  if (u.password !== u.confirm_password) return 'Password and confirmation do not match.';
  return null;
}

async function usernameTaken(username) {
  return Boolean(await db.prepare('SELECT 1 FROM users WHERE username = ?').get(username));
}

async function createUser(u, role = 'member') {
  await db.prepare(`
    INSERT INTO users (username, password_hash, full_name, email, role, title)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(u.username, bcrypt.hashSync(u.password, 10), u.full_name, u.email || null, role, u.title || null);
}

module.exports = { normalizeNewUser, validateNewUser, usernameTaken, createUser };
