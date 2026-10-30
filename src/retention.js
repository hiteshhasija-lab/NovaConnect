// Message retention (Phase 3, "Admin and compliance"): an admin-set policy that deletes messages once
// they are older than a number of days, one setting for channels and one for chats (1:1, group and
// meeting chats). Off ("keep forever") until an admin saves a policy (Admin -> Retention,
// routes/admin.js), so an upgrade deletes nothing.
//
// What a run deletes, for each message past its scope's limit:
//   - a reply, or a post without replies: the message itself, with its reactions, edit history,
//     notifications (all cascade) and its files (the stored object too, unless another attachment
//     or a recording still uses it), and its search entry;
//   - a post whose thread still has newer replies: its text, banner and files, leaving "This message
//     was deleted" above the replies; the row goes once the last reply has expired too.
// Kept regardless: messages on legal hold (src/legalHold.js), and workflow cards still waiting for an
// answer (a NovaDesk approval or confirmation), so a slow approval can't vanish under the person who
// has to give it.
// Runs from the scheduler at most once an hour, or when an admin presses "Run now". Each run that
// deletes anything is written to the audit log with its counts (never the text).
const { db, nowStr } = require('./db');
const { deleteFile } = require('./storage');
const { heldSql } = require('./legalHold');

// The choices offered (days); null is "keep forever".
const RETENTION_OPTIONS = [null, 30, 90, 180, 365, 730, 1825, 2555];
const SETTING_KEY = 'retention';
const BATCH = 500;
const RUN_EVERY_MS = 60 * 60 * 1000;

function parsePolicy(body) {
  const b = body || {};
  const days = (v) => {
    if (v === null || v === undefined || v === '' || v === 'forever') return null;
    const n = Number(v);
    return RETENTION_OPTIONS.includes(n) ? n : undefined;
  };
  const channel = days(b.channel_days), chat = days(b.chat_days);
  if (channel === undefined || chat === undefined) return { error: 'Choose one of the offered retention periods.' };
  return { value: { channel_days: channel, chat_days: chat } };
}

async function getPolicy() {
  const row = await db.prepare(`
    SELECT s.value, s.updated_at, u.full_name AS updated_by_name FROM org_settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?
  `).get(SETTING_KEY);
  let value = { channel_days: null, chat_days: null };
  if (row) { try { value = { ...value, ...JSON.parse(row.value) }; } catch { /* keep forever */ } }
  return { ...value, updated_at: row?.updated_at || null, updated_by_name: row?.updated_by_name || null };
}

async function setPolicy(value, userId) {
  await db.prepare(`
    INSERT INTO org_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
  `).run(SETTING_KEY, JSON.stringify(value), nowStr(), userId);
}

// 'YYYY-MM-DD HH:MM:SS' (UTC) `days` before `nowMs`: messages created before it are past the limit.
function cutoffFor(days, nowMs = Date.now()) {
  return new Date(nowMs - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

// SQL for "message m is past its scope's limit and may go". Bindings: the cutoff.
// (No '?' may appear anywhere else in this text: knex reads every one as a binding.)
const SCOPE = { channel: 'm.channel_id IS NOT NULL', chat: 'm.conversation_id IS NOT NULL' };
const PENDING_CARD = `(COALESCE(m.metadata, '') LIKE '%"cardType"%' AND m.metadata LIKE '%"status":"pending"%')`;
// Messages on legal hold (src/legalHold.js) are never touched, and a held reply keeps its thread's post.
const expiredSql = (scope) => `${SCOPE[scope]} AND m.created_at < ? AND NOT ${PENDING_CARD} AND NOT ${heldSql('m')}`;

// Files of these messages, then (after the rows are gone) the stored objects nothing else uses.
async function filesOf(ids) {
  if (!ids.length) return [];
  return db.prepare(`SELECT id, COALESCE(storage_key, filename) AS key, storage_driver, thumb_key, thumb_driver FROM attachments WHERE message_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}
async function removeStoredFiles(files) {
  let removed = 0;
  for (const f of files) {
    if (!f.key) continue;
    const used = await db.prepare(`
      SELECT 1 FROM attachments WHERE COALESCE(storage_key, filename) = ? UNION ALL SELECT 1 FROM recordings WHERE storage_key = ? LIMIT 1
    `).get(f.key, f.key);
    if (used) continue;
    try { await deleteFile(f.key, f.storage_driver); removed++; } catch (e) { console.error('retention: could not delete a stored file:', e.message); }
    // Its thumbnail goes with it (a forwarded copy shares both, so the same check covers it).
    if (f.thumb_key) await deleteFile(f.thumb_key, f.thumb_driver).catch(e => console.error('retention: could not delete a thumbnail:', e.message));
  }
  return removed;
}

async function purgeScope(scope, days, nowMs, unindex) {
  const cutoff = cutoffFor(days, nowMs);
  const counts = { deleted: 0, cleared: 0, files: 0 };
  // 1. Replies and posts without replies (live replies counted in SQL, so the order doesn't matter).
  for (;;) {
    const rows = await db.prepare(`
      SELECT m.id FROM messages m
      WHERE ${expiredSql(scope)} AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.parent_message_id = m.id)
      ORDER BY m.id LIMIT ${BATCH}
    `).all(cutoff);
    if (!rows.length) break;
    const ids = rows.map(r => r.id);
    const files = await filesOf(ids);
    await db.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    counts.deleted += ids.length;
    counts.files += await removeStoredFiles(files);
    await unindex(ids);
    // No early stop on a short batch: deleting a thread's last replies makes its post eligible next.
  }
  // 2. Posts whose threads still have (newer) replies: clear them, keep the row for the thread.
  for (;;) {
    const rows = await db.prepare(`
      SELECT m.id FROM messages m WHERE ${expiredSql(scope)} AND m.parent_message_id IS NULL AND m.deleted = 0
      ORDER BY m.id LIMIT ${BATCH}
    `).all(cutoff);
    if (!rows.length) break;
    const ids = rows.map(r => r.id);
    const list = ids.map(() => '?').join(',');
    const files = await filesOf(ids);
    await db.prepare(`UPDATE messages SET deleted = 1, body = '', metadata = NULL, updated_at = ? WHERE id IN (${list})`).run(nowStr(), ...ids);
    await db.prepare(`DELETE FROM attachments WHERE message_id IN (${list})`).run(...ids);
    await db.prepare(`DELETE FROM message_edits WHERE message_id IN (${list})`).run(...ids);
    counts.cleared += ids.length;
    counts.files += await removeStoredFiles(files);
    await unindex(ids);
    if (rows.length < BATCH) break;
  }
  return counts;
}

// One run with the saved policy. Returns what it did: { ran, channel, chat, meeting_chat }.
async function runRetention({ nowMs = Date.now(), unindex = async () => {} } = {}) {
  const policy = await getPolicy();
  const result = { ran: false, policy, channel: null, chat: null, meeting_chat: 0 };
  if (policy.channel_days) { result.ran = true; result.channel = await purgeScope('channel', policy.channel_days, nowMs, unindex); }
  if (policy.chat_days) {
    result.ran = true;
    result.chat = await purgeScope('chat', policy.chat_days, nowMs, unindex);
    // A person on legal hold keeps their meeting-chat lines too.
    const m = await db.prepare(`DELETE FROM meet_chat_messages mc WHERE mc.created_at < ?
      AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.released_at IS NULL AND h.scope_type = 'person' AND h.scope_id = mc.user_id)`).run(cutoffFor(policy.chat_days, nowMs));
    result.meeting_chat = m.changes || 0;
  }
  return result;
}

const removedSomething = (r) => !!(r.meeting_chat || ['channel', 'chat'].some(k => r[k] && (r[k].deleted || r[k].cleared || r[k].files)));

// The scheduler's hourly run (scheduler.js ticks every 15 s; this skips until an hour has passed).
let lastRunAt = 0;
async function maybeRunRetention({ audit, unindex }) {
  if (Date.now() - lastRunAt < RUN_EVERY_MS) return null;
  lastRunAt = Date.now();
  const r = await runRetention({ unindex });
  if (r.ran && removedSomething(r)) await audit(null, 'retention.run', { details: summary(r) });
  return r;
}

// The counts for the audit log and the admin page.
function summary(r) {
  return {
    channel_days: r.policy.channel_days, chat_days: r.policy.chat_days,
    channel_deleted: r.channel?.deleted || 0, channel_cleared: r.channel?.cleared || 0,
    chat_deleted: r.chat?.deleted || 0, chat_cleared: r.chat?.cleared || 0,
    meeting_chat_deleted: r.meeting_chat || 0, files_deleted: (r.channel?.files || 0) + (r.chat?.files || 0),
  };
}

// How many messages the policy would delete now (the admin page shows it before saving).
async function preview(value, nowMs = Date.now()) {
  const count = async (scope, days) => (days ? Number((await db.prepare(`SELECT COUNT(*) AS c FROM messages m WHERE ${expiredSql(scope)}`).get(cutoffFor(days, nowMs))).c) : 0);
  return { channel: await count('channel', value.channel_days), chat: await count('chat', value.chat_days) };
}

module.exports = {
  RETENTION_OPTIONS, parsePolicy, getPolicy, setPolicy, cutoffFor, runRetention, maybeRunRetention, summary, preview, removedSomething,
};
