// Audit log (Phase 3, "Admin and compliance"): an append-only record of who did what, when and from
// where, for admins (Admin -> Audit log, routes/admin.js). Written by the routes that do the thing,
// right after it succeeds. Never message text, never a password. The table is in
// migrations/1792400000000_audit-log-and-retention.js.
//
// Writing never fails the action it records: a database error is logged and the action stands.
const { db, nowStr } = require('./db');

// Every action, with how the admin page names it. The group (before the dot) is the page's filter.
const ACTIONS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.logout': 'Signed out',
  'auth.register': 'Created their account',
  'auth.password_change': 'Changed their password',
  'admin.user_create': 'Added a user',
  'admin.user_deactivate': 'Deactivated a user',
  'admin.user_activate': 'Reactivated a user',
  'admin.role_change': "Changed a user's role",
  'admin.password_reset': "Reset a user's password",
  'team.create': 'Created a team',
  'team.delete': 'Deleted a team',
  'team.member_add': 'Added a team member',
  'team.member_remove': 'Removed a team member',
  'team.leave': 'Left a team',
  'team.settings': "Changed a team's settings",
  'channel.create': 'Created a channel',
  'channel.delete': 'Deleted a channel',
  'message.delete': 'Deleted a message',
  'message.recall_search': 'Searched messages to recall',
  'message.recall': 'Removed messages for everyone (recall)',
  'retention.policy': 'Changed message retention',
  'retention.run': 'Retention deleted old messages',
  'audit.export': 'Exported the audit log',
  'webhook.create': 'Made an incoming webhook',
  'webhook.revoke': 'Revoked an incoming webhook',
  'hold.create': 'Placed a legal hold',
  'hold.release': 'Released a legal hold',
  'hold.view': 'Viewed preserved messages',
};
const GROUPS = { auth: 'Sign-in', admin: 'Users', team: 'Teams', channel: 'Channels', message: 'Messages', retention: 'Retention', hold: 'Legal hold', webhook: 'Webhooks', audit: 'Audit log' };

const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

// req: the request (actor, IP, browser) or null for the app itself (retention runs).
// opts.actor overrides the signed-in user (a sign-in records who just signed in; a failed one, nobody).
async function audit(req, action, { actor, targetType, targetId, targetName, details } = {}) {
  try {
    const who = actor !== undefined ? actor : req?.session?.user || null;
    await db.prepare(`
      INSERT INTO audit_log (at, actor_id, actor_name, action, target_type, target_id, target_name, ip, user_agent, details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nowStr(), who?.id ?? null, clip(who ? (who.full_name || who.username) : null, 200), action,
      clip(targetType, 40), clip(targetId, 80), clip(targetName, 200), clip(req?.ip, 64),
      clip(req?.get ? req.get('user-agent') : null, 300), details ? JSON.stringify(details).slice(0, 4000) : null);
  } catch (e) {
    console.error('audit write failed:', action, e.message);
  }
}

// The admin page's filters, from the query string: group, person (actor id), from/to days
// (YYYY-MM-DD, UTC, to inclusive), before (an id, for paging). Returns SQL conditions and params.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function auditFilters(q = {}) {
  const where = [], params = [], applied = {};
  if (typeof q.group === 'string' && GROUPS[q.group]) { where.push('action LIKE ?'); params.push(q.group + '.%'); applied.group = q.group; }
  const person = Number(q.person);
  if (Number.isSafeInteger(person) && person > 0) { where.push('actor_id = ?'); params.push(person); applied.person = person; }
  if (typeof q.from === 'string' && DAY.test(q.from)) { where.push('at >= ?'); params.push(q.from + ' 00:00:00'); applied.from = q.from; }
  if (typeof q.to === 'string' && DAY.test(q.to)) { where.push('at <= ?'); params.push(q.to + ' 23:59:59'); applied.to = q.to; }
  const before = Number(q.before);
  if (Number.isSafeInteger(before) && before > 0) { where.push('id < ?'); params.push(before); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, applied };
}

// CSV for the export. A cell starting with = + - @ (or a tab / carriage return) is prefixed with
// ' so a spreadsheet shows it as text instead of running it as a formula.
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const CSV_COLUMNS = ['id', 'at', 'actor_id', 'actor_name', 'action', 'target_type', 'target_id', 'target_name', 'ip', 'user_agent', 'details'];
function auditCsv(rows) {
  return [CSV_COLUMNS.join(','), ...rows.map(r => CSV_COLUMNS.map(c => csvCell(c === 'at' ? r.at + 'Z' : r[c])).join(','))].join('\r\n') + '\r\n';
}

module.exports = { audit, ACTIONS, GROUPS, auditFilters, auditCsv, csvCell };
