const { db, nowStr } = require('./db');
const { hydrateOne } = require('./messageUtils');
const { emitToChannel, emitToConversation } = require('./realtime');

const RESOLVABLE_CARD_TYPES = ['decom_approval', 'decom_confirm_destroy', 'decom_skip_manual_tasks', 'decom_precheck_task'];

// A logical decom card (identified by changeId + cardType + taskId) can now exist as more than
// one message row — one in the DM a request started from, one broadcast into server-decom (see
// decomFlow.js's handleDecomTrigger). Resolving one must resolve every copy, regardless of
// which copy the action actually came from, or the others are left stuck showing stale buttons.
// The lookup works purely off each message's own stored metadata (already has changeId/
// cardType/taskId) — no separate mapping table needed. taskId is absent from metadata for
// change-level cards (approval, confirm-destroy, skip-manual-tasks), hence the COALESCE-to--1
// dance so "no taskId on either side" counts as a match.
async function resolveDecomCards({ changeId, cardType, taskId }, status) {
  if (!RESOLVABLE_CARD_TYPES.includes(cardType)) return;
  const rows = await db.prepare(`
    SELECT * FROM messages
    WHERE (metadata::jsonb->>'changeId')::int = ?
      AND metadata::jsonb->>'cardType' = ?
      AND COALESCE((metadata::jsonb->>'taskId')::int, -1) = COALESCE(?::int, -1)
  `).all(changeId, cardType, taskId ?? null);

  for (const row of rows) {
    let meta;
    try { meta = JSON.parse(row.metadata); } catch { continue; }
    meta.status = status;
    const updated = await db.prepare(`
      UPDATE messages SET metadata = ?, updated_at = ? WHERE id = ? RETURNING *
    `).get(JSON.stringify(meta), nowStr(), row.id);
    const message = await hydrateOne(updated, null);
    if (row.channel_id) emitToChannel(row.channel_id, 'message:update', message);
    else emitToConversation(row.conversation_id, 'message:update', message);
  }
}

// Resolve starting from the specific message a user clicked — reads that message's own
// changeId/cardType/taskId out of its metadata, then resolves every sibling (itself included)
// via resolveDecomCards. This is the entry point for clicks inside this app; NovaDesk-triggered
// resolves (e.g. the Change Tasks toggle button) call resolveDecomCards directly with a key it
// already knows, since it has no message id to start from.
async function resolveDecomCardByMessageId(messageId, status) {
  if (!messageId) return;
  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!row || !row.metadata) return;
  let meta;
  try { meta = JSON.parse(row.metadata); } catch { return; }
  await resolveDecomCards({ changeId: meta.changeId, cardType: meta.cardType, taskId: meta.taskId }, status);
}

module.exports = { resolveDecomCards, resolveDecomCardByMessageId };
