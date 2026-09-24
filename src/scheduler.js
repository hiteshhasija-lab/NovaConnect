// Delivers due rows from scheduled_messages — persisted (not a bare setTimeout) so a
// podman pod recreate (routine — cert rotation, IP changes) can't silently lose a pending
// scheduled send. Polls rather than using per-row timers for the same reason: this process
// may not be the one still running when a message eventually comes due.
const { db, nowStr } = require('./db');
const { hydrateOne } = require('./messageUtils');
const { emitToChannel, emitToConversation } = require('./realtime');
const { recordMentions, channelMemberIds } = require('./routes/messages');

const POLL_INTERVAL_MS = 15000;

async function deliverOne(sched) {
  const row = await db.prepare(`
    INSERT INTO messages (channel_id, conversation_id, user_id, body, parent_message_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(sched.channel_id, sched.conversation_id, sched.user_id, sched.body, sched.parent_message_id, nowStr(), nowStr());

  if (sched.conversation_id) {
    await db.prepare(`
      UPDATE dm_participants SET is_hidden = 0, is_unread = CASE WHEN user_id = ? THEN 0 ELSE 1 END WHERE conversation_id = ?
    `).run(sched.user_id, sched.conversation_id);
  }

  const message = await hydrateOne(row, sched.user_id);
  const event = sched.parent_message_id ? 'thread:message' : 'message:new';
  if (sched.channel_id) emitToChannel(sched.channel_id, event, message);
  else emitToConversation(sched.conversation_id, event, message);

  if (sched.channel_id && !sched.parent_message_id) {
    const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(sched.channel_id);
    if (channel) {
      const memberIds = await channelMemberIds(channel);
      const memberRows = memberIds.length
        ? await db.prepare(`SELECT id, full_name FROM users WHERE id IN (${memberIds.map(() => '?').join(',')})`).all(...memberIds)
        : [];
      await recordMentions({ body: sched.body, authorId: sched.user_id, memberRows, channelId: sched.channel_id, conversationId: null, messageId: row.id });
    }
  }

  await db.prepare(`UPDATE scheduled_messages SET status = 'sent' WHERE id = ?`).run(sched.id);
}

async function deliverDue() {
  const due = await db.prepare(`SELECT * FROM scheduled_messages WHERE status = 'pending' AND send_at <= ? ORDER BY id`).all(nowStr());
  for (const sched of due) {
    try {
      await deliverOne(sched);
    } catch (e) {
      console.error('Failed to deliver scheduled message', sched.id, e.message);
      await db.prepare(`UPDATE scheduled_messages SET status = 'failed' WHERE id = ?`).run(sched.id).catch(() => {});
    }
  }
}

// Actually clears expired status messages (rather than leaving every reader to check
// status_message_expires_at itself) so the DB always reflects the true current state.
async function clearExpiredStatusMessages() {
  await db.prepare(`
    UPDATE users SET status_message = NULL, status_message_expires_at = NULL
    WHERE status_message_expires_at IS NOT NULL AND status_message_expires_at <= ?
  `).run(nowStr());
}

function start() {
  const tick = () => Promise.all([
    deliverDue().catch(e => console.error('scheduler run failed:', e.message)),
    clearExpiredStatusMessages().catch(e => console.error('status-message expiry sweep failed:', e.message))
  ]);
  tick();
  setInterval(tick, POLL_INTERVAL_MS);
}

module.exports = { start };
