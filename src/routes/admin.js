const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { normalizeNewUser, validateNewUser, usernameTaken, createUser } = require('../newUser');
const bcrypt = require('bcryptjs');
const { validateNewPassword } = require('../passwordChange');
const { revokeUserSessions } = require('../sessions');
const { disconnectUser } = require('../realtime');
const { audit, ACTIONS, GROUPS, auditFilters, auditCsv } = require('../audit');
const retention = require('../retention');
const { removeMessages } = require('../search');
const legalHold = require('../legalHold');
const { recallFilters, recallIds } = require('../recall');
const { deleteForEveryone } = require('../messageDelete');
const ediscovery = require('../ediscovery');
const { serveStored } = require('../storage');

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

// ---------------- recall ----------------
// Find messages anywhere and remove them for everyone, with a reason (src/recall.js).
async function recallPage(req, res, { notice = null, error = null, status = 200, q = req.query } = {}) {
  const people = await db.prepare('SELECT id, full_name, username, active FROM users ORDER BY full_name').all();
  const channels = await db.prepare('SELECT c.id, c.name, t.name AS team FROM channels c LEFT JOIN teams t ON t.id = c.team_id ORDER BY t.name, c.name').all();
  const searching = ['person', 'channel', 'chat', 'from', 'to', 'words'].some(k => q[k]);
  let rows = [], applied = {};
  if (searching) {
    const f = recallFilters(q);
    if (f.error) error = error || f.error;
    else {
      applied = f.applied;
      rows = await db.prepare(`
        SELECT m.id, m.body, m.metadata, m.created_at, m.channel_id, m.conversation_id, m.parent_message_id, u.full_name AS author, c.name AS channel_name, t.name AS team_name
        FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN teams t ON t.id = c.team_id
        ${f.sql} ORDER BY m.id DESC LIMIT 200
      `).all(...f.params);
      await audit(req, 'message.recall_search', { details: { ...applied, found: rows.length } });
    }
  }
  const query = new URLSearchParams(Object.entries(applied).map(([k, v]) => [k, String(v)])).toString();
  res.status(status).render('admin-recall', { title: 'Recall messages', people, channels, rows, applied, searching, query, notice, error });
}
router.get('/recall', async (req, res) => recallPage(req, res));
router.post('/recall', async (req, res) => {
  const ids = recallIds(req.body.ids);
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  // The search the page was showing, so it is shown again (without what was just removed).
  const q = Object.fromEntries(new URLSearchParams(typeof req.body.query === 'string' ? req.body.query : ''));
  if (!ids.length) return recallPage(req, res, { error: 'Tick the messages to remove.', status: 400, q });
  if (!reason || reason.length > 500) return recallPage(req, res, { error: 'Give a reason (up to 500 characters); it goes in the audit log.', status: 400, q });
  const msgs = await db.prepare(`
    SELECT m.*, c.name AS channel_name FROM messages m LEFT JOIN channels c ON c.id = m.channel_id WHERE m.id IN (${ids.map(() => '?').join(',')}) AND m.deleted = 0
  `).all(...ids);
  const kept = [];
  for (const m of msgs) {
    const place = m.channel_id ? '#' + m.channel_name : 'chat #' + m.conversation_id;
    const holdIds = await deleteForEveryone(m, { byUserId: req.session.user.id, place, recalled: true });
    if (holdIds.length) kept.push(m.id);
  }
  await audit(req, 'message.recall', { targetType: 'message', targetName: `${msgs.length} message(s)`, details: {
    reason, removed: msgs.length, message_ids: msgs.map(m => m.id).join(','), authors: [...new Set(msgs.map(m => m.user_id))].join(','),
    ...(kept.length ? { preserved_for_hold: kept.join(',') } : {}),
  } });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ removed: msgs.length, preserved: kept.length });
  recallPage(req, res, { notice: `Removed ${msgs.length} message(s) for everyone${kept.length ? `; ${kept.length} on legal hold kept a copy` : ''}.`, q });
});

// ---------------- eDiscovery ----------------
// Cases with one search each, previewed and exported (src/ediscovery.js). Everything is audited.
const caseById = (id) => db.prepare(`
  SELECT k.*, cu.full_name AS created_by_name, xu.full_name AS closed_by_name FROM ediscovery_cases k
  LEFT JOIN users cu ON cu.id = k.created_by LEFT JOIN users xu ON xu.id = k.closed_by WHERE k.id = ?
`).get(Number(id) || 0);
const criteriaOf = (k) => ediscovery.parseCriteria(JSON.parse(k.criteria || '{}')).value;
router.get('/ediscovery', async (req, res) => {
  const cases = await db.prepare(`SELECT k.*, u.full_name AS created_by_name FROM ediscovery_cases k LEFT JOIN users u ON u.id = k.created_by ORDER BY (k.closed_at IS NULL) DESC, k.id DESC`).all();
  res.render('admin-ediscovery', { title: 'eDiscovery', cases, error: null });
});
router.post('/ediscovery', async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  if (!name || name.length > 120 || description.length > 2000) {
    const cases = await db.prepare('SELECT k.*, NULL AS created_by_name FROM ediscovery_cases k ORDER BY k.id DESC').all();
    return res.status(400).render('admin-ediscovery', { title: 'eDiscovery', cases, error: 'Give the case a name of up to 120 characters (and a description of up to 2000).' });
  }
  const k = await db.prepare('INSERT INTO ediscovery_cases (name, description, criteria, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .get(name, description, JSON.stringify(ediscovery.parseCriteria({}).value), req.session.user.id, nowStr());
  await audit(req, 'ediscovery.create', { targetType: 'case', targetId: k.id, targetName: name });
  if (req.accepts(['html', 'json']) === 'json') return res.status(201).json({ id: k.id });
  res.redirect(`/admin/ediscovery/${k.id}`);
});
// The case: its search (editable while open), and with ?run=1 the results (newest 100).
router.get('/ediscovery/:id', async (req, res) => {
  const k = await caseById(req.params.id);
  if (!k) return res.status(404).render('error', { title: 'Not Found', message: 'That case does not exist.' });
  const c = criteriaOf(k);
  let result = null;
  if (req.query.run) {
    result = await ediscovery.runSearch(c, { limit: 100 });
    await db.prepare('UPDATE ediscovery_cases SET last_run_at = ?, last_count = ? WHERE id = ?').run(nowStr(), result.total, k.id);
    await audit(req, 'ediscovery.search', { targetType: 'case', targetId: k.id, targetName: k.name, details: { criteria: ediscovery.describe(c), found: result.total } });
  }
  if (req.accepts(['html', 'json']) === 'json') return res.json({ case: { ...k, criteria: c }, result });
  const people = await db.prepare('SELECT id, full_name, username, active FROM users ORDER BY full_name').all();
  const channels = await db.prepare('SELECT c.id, c.name, t.name AS team FROM channels c LEFT JOIN teams t ON t.id = c.team_id ORDER BY t.name, c.name').all();
  res.render('admin-ediscovery-case', { title: 'eDiscovery: ' + k.name, k, c, result, people, channels, describe: ediscovery.describe(c), error: null });
});
router.post('/ediscovery/:id/criteria', async (req, res) => {
  const k = await caseById(req.params.id);
  if (!k) return res.status(404).json({ error: 'That case does not exist.' });
  if (k.closed_at) return res.status(409).json({ error: 'This case is closed; its search can no longer change.' });
  // From the page's form an unticked box isn't sent at all: there, a missing box means off.
  const body = req.body.form === '1' ? { include_preserved: false, include_versions: false, ...req.body } : req.body;
  const parsed = ediscovery.parseCriteria(body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  await db.prepare('UPDATE ediscovery_cases SET criteria = ? WHERE id = ?').run(JSON.stringify(parsed.value), k.id);
  await audit(req, 'ediscovery.criteria', { targetType: 'case', targetId: k.id, targetName: k.name, details: { criteria: ediscovery.describe(parsed.value) } });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ criteria: parsed.value });
  res.redirect(`/admin/ediscovery/${k.id}?run=1`);
});
// Everything the search finds (up to 50,000 messages), as CSV or JSON.
router.get('/ediscovery/:id/export.:format(csv|json)', async (req, res) => {
  const k = await caseById(req.params.id);
  if (!k) return res.status(404).render('error', { title: 'Not Found', message: 'That case does not exist.' });
  const c = criteriaOf(k);
  const result = await ediscovery.runSearch(c, { limit: 50000 });
  await audit(req, 'ediscovery.export', { targetType: 'case', targetId: k.id, targetName: k.name, details: { format: req.params.format, items: result.items.length, criteria: ediscovery.describe(c) } });
  const file = `novaconnect-case-${k.id}-${new Date().toISOString().slice(0, 10)}.${req.params.format}`;
  res.set('Content-Disposition', `attachment; filename="${file}"`);
  if (req.params.format === 'csv') return res.type('text/csv; charset=utf-8').send(ediscovery.caseCsv(result.items));
  res.type('application/json').send(JSON.stringify({
    case: { id: k.id, name: k.name, description: k.description, opened: k.created_at, opened_by: k.created_by_name, closed: k.closed_at },
    search: { ...c, described: ediscovery.describe(c) }, exported_at: nowStr(), exported_by: req.session.user.full_name || req.session.user.username,
    counts: { live: result.live, preserved: result.preserved, total: result.total, in_this_file: result.items.length }, items: result.items,
  }, null, 2));
});
// A file of a message the case's search finds (live, or kept by a legal hold).
router.get('/ediscovery/:id/files/:attachmentId', async (req, res) => {
  const k = await caseById(req.params.id);
  const att = await db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(req.params.attachmentId) || 0);
  if (!k || !att) return res.status(404).render('error', { title: 'Not Found', message: 'That file is not in this case.' });
  const inCase = await ediscovery.runSearch({ ...criteriaOf(k), include_preserved: true }, { limit: 1, onlyMessageId: att.message_id });
  if (!inCase.total) return res.status(404).render('error', { title: 'Not Found', message: 'That file is not in this case.' });
  await audit(req, 'ediscovery.file', { targetType: 'case', targetId: k.id, targetName: k.name, details: { attachment: att.id, file: att.original_name, message: att.message_id } });
  await serveStored(req, res, { key: att.storage_key || att.filename, driver: att.storage_driver, name: att.original_name });
});
router.post('/ediscovery/:id/close', async (req, res) => {
  const k = await db.prepare('UPDATE ediscovery_cases SET closed_at = ?, closed_by = ? WHERE id = ? AND closed_at IS NULL RETURNING id, name')
    .get(nowStr(), req.session.user.id, Number(req.params.id) || 0);
  if (!k) return res.status(404).json({ error: 'That case is not open.' });
  await audit(req, 'ediscovery.close', { targetType: 'case', targetId: k.id, targetName: k.name });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
  res.redirect(`/admin/ediscovery/${k.id}`);
});

// ---------------- legal hold ----------------
// Holds keep a person's, channel's or chat's messages from being destroyed (src/legalHold.js).
async function renderHolds(res, { notice = null, error = null, status = 200, form = {} } = {}) {
  const holds = await db.prepare(`
    SELECT h.*, cu.full_name AS created_by_name, ru.full_name AS released_by_name,
      (SELECT COUNT(*) FROM preserved_messages p WHERE (',' || p.hold_ids || ',') LIKE ('%,' || h.id || ',%')) AS preserved
    FROM legal_holds h LEFT JOIN users cu ON cu.id = h.created_by LEFT JOIN users ru ON ru.id = h.released_by
    ORDER BY (h.released_at IS NULL) DESC, h.id DESC
  `).all();
  for (const h of holds) h.covered = h.released_at ? null : await legalHold.coveredCount(h);
  const people = await db.prepare('SELECT id, full_name, username FROM users ORDER BY full_name').all();
  const channels = await db.prepare('SELECT c.id, c.name, t.name AS team FROM channels c LEFT JOIN teams t ON t.id = c.team_id ORDER BY t.name, c.name').all();
  res.status(status).render('admin-holds', { title: 'Legal hold', holds, people, channels, scopes: legalHold.SCOPES, notice, error, form });
}
router.get('/holds', async (req, res) => renderHolds(res));
router.post('/holds', async (req, res) => {
  const parsed = legalHold.parseHold(req.body);
  if (parsed.error) return renderHolds(res, { error: parsed.error, status: 400, form: req.body });
  const v = parsed.value;
  const label = await legalHold.scopeLabel(v.scope_type, v.scope_id);
  if (!label) return renderHolds(res, { error: `That ${legalHold.SCOPES[v.scope_type].toLowerCase()} doesn't exist.`, status: 400, form: req.body });
  const hold = await db.prepare(`
    INSERT INTO legal_holds (name, reason, scope_type, scope_id, scope_label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
  `).get(v.name, v.reason, v.scope_type, v.scope_id, label, req.session.user.id, nowStr());
  await audit(req, 'hold.create', { targetType: 'hold', targetId: hold.id, targetName: v.name, details: { holds: label, scope: v.scope_type } });
  if (req.accepts(['html', 'json']) === 'json') return res.status(201).json({ id: hold.id, scope_label: label });
  renderHolds(res, { notice: `Legal hold "${v.name}" placed on ${label}.` });
});
router.post('/holds/:id/release', async (req, res) => {
  const hold = await db.prepare(`UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ? AND released_at IS NULL RETURNING id, name, scope_label`)
    .get(nowStr(), req.session.user.id, Number(req.params.id) || 0);
  if (!hold) return renderHolds(res, { error: 'That hold is not active.', status: 404 });
  await audit(req, 'hold.release', { targetType: 'hold', targetId: hold.id, targetName: hold.name, details: { holds: hold.scope_label } });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ ok: true });
  renderHolds(res, { notice: `Legal hold "${hold.name}" released. What it preserved is kept.` });
});
// What a hold preserved (messages deleted while it was active), newest first. Viewing is logged.
router.get('/holds/:id', async (req, res) => {
  const hold = await db.prepare('SELECT * FROM legal_holds WHERE id = ?').get(Number(req.params.id) || 0);
  if (!hold) return res.status(404).render('error', { title: 'Not Found', message: 'That hold does not exist.' });
  const rows = await db.prepare(`SELECT * FROM preserved_messages WHERE (',' || hold_ids || ',') LIKE ? ORDER BY id DESC LIMIT 500`).all(`%,${hold.id},%`);
  for (const r of rows) {
    const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
    r.editList = parse(r.edits) || [];
    r.fileList = parse(r.attachments) || [];
    r.announcement = parse(r.metadata)?.announcement || null;
  }
  await audit(req, 'hold.view', { targetType: 'hold', targetId: hold.id, targetName: hold.name, details: { entries: rows.length } });
  if (req.accepts(['html', 'json']) === 'json') return res.json({ hold, preserved: rows });
  res.render('admin-hold', { title: 'Legal hold: ' + hold.name, hold, rows });
});

module.exports = router;
