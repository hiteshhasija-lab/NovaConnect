const bcrypt = require('bcryptjs');

function validateNewPassword(newPassword, confirmation) {
  if (!newPassword || newPassword.length < 8) return 'New password must be at least 8 characters.';
  if (newPassword !== confirmation) return 'New password and confirmation do not match.';
  return null;
}

async function replacePassword(db, userId, newPassword, hash = bcrypt.hash) {
  const passwordHash = await hash(newPassword, 10);
  await db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(passwordHash, userId);
}

module.exports = { validateNewPassword, replacePassword };
