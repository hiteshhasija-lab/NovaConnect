const createAsyncRouter = require('../asyncRouter');
const { requireAuth } = require('../middleware/auth');
const { callNovaDesk, postBotMessage } = require('../decomFlow');
const { db, nowStr } = require('../db');
const { hydrateOne } = require('../messageUtils');
const { emitToChannel } = require('../realtime');

const router = createAsyncRouter();
router.use(requireAuth);

// Marks the original approval-card message as resolved (not just posting a follow-up),
// so a page refresh doesn't show stale, already-acted-on Approve/Reject buttons.
async function resolveCardMessage(messageId, status) {
  if (!messageId) return;
  const row = await db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!row || !row.metadata) return;
  let meta;
  try { meta = JSON.parse(row.metadata); } catch { return; }
  if (meta.cardType !== 'decom_approval' && meta.cardType !== 'decom_confirm_destroy' && meta.cardType !== 'decom_skip_manual_tasks' && meta.cardType !== 'decom_precheck_task') return;
  meta.status = status;
  const updated = await db.prepare(`
    UPDATE messages SET metadata = ?, updated_at = ? WHERE id = ? RETURNING *
  `).get(JSON.stringify(meta), nowStr(), messageId);
  const message = await hydrateOne(updated, null);
  emitToChannel(row.channel_id, 'message:update', message);
}

// All routes below are relative — this router is mounted at app.use('/api/decom', ...) in
// server.js, not '/'. Mounting a router with its own router.use(requireAuth) gate at '/' was
// the exact bug behind the earlier NovaDesk outage (see server-decom-workflow memory) — it
// silently intercepts every request reaching the app, including unrelated routers mounted
// afterward. That's precisely what happened here: this router being mounted at '/' with full
// '/api/decom/...' paths was catching requests meant for the separate
// '/api/integrations/novadesk/decom-updates' router mounted later in server.js, rejecting them
// with 401 "Not signed in." before they ever reached it. Fixed 2026-09-21.
router.post('/:changeId/approve', async (req, res) => {
  const channelId = req.body.channel_id;
  if (!channelId) return res.status(400).json({ error: 'channel_id is required.' });
  const user = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(req.session.user.id);

  try {
    const { change } = await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/approve`, {
      approved_by_username: user.username
    });
    await resolveCardMessage(req.body.message_id, 'approved');
    await postBotMessage(
      channelId,
      `✅ ${change.number} approved by ${user.full_name}. Scheduled for decommission.`,
      { cardType: 'decom_status', changeId: change.id, changeNumber: change.number, status: 'approved' }
    );
    res.json({ ok: true, change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:changeId/reject', async (req, res) => {
  const channelId = req.body.channel_id;
  if (!channelId) return res.status(400).json({ error: 'channel_id is required.' });
  const user = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(req.session.user.id);

  try {
    const { change } = await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/reject`, {
      rejected_by_username: user.username
    });
    await resolveCardMessage(req.body.message_id, 'rejected');
    await postBotMessage(
      channelId,
      `❌ ${change.number} rejected by ${user.full_name}.`,
      { cardType: 'decom_status', changeId: change.id, changeNumber: change.number, status: 'rejected' }
    );
    res.json({ ok: true, change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The second checkpoint's action route — same relay-to-NovaDesk-then-resolve-the-card shape
// as approve/reject above, deliberately not collapsed into a shared helper with them since the
// backend call, message copy, and resulting card status ('destroyed', not 'approved'/'rejected')
// all differ enough that sharing would just add indirection.
router.post('/:changeId/confirm-destroy', async (req, res) => {
  const channelId = req.body.channel_id;
  if (!channelId) return res.status(400).json({ error: 'channel_id is required.' });
  const user = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(req.session.user.id);

  try {
    const { change } = await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/confirm-destroy`, {
      confirmed_by_username: user.username
    });
    await resolveCardMessage(req.body.message_id, 'destroyed');
    res.json({ ok: true, change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The 3 non-automated pre-checks (backup/monitoring/DNS) — a lightweight relay, same shape as
// confirm-destroy above: no separate follow-up message needed, the card resolving in place is
// the confirmation.
router.post('/:changeId/skip-manual-tasks', async (req, res) => {
  const user = await db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.user.id);

  try {
    await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/skip-manual-tasks`, {
      skipped_by_username: user.username
    });
    await resolveCardMessage(req.body.message_id, 'skipped');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Individual pre-check confirmation prompt action: Complete or Skip.
router.post('/:changeId/precheck-task', async (req, res) => {
  const channelId = req.body.channel_id;
  const user = await db.prepare('SELECT username FROM users WHERE id = ?').get(req.session.user.id);
  const action = req.body.action; // 'complete' or 'skip'

  try {
    await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/precheck-task`, {
      action,
      task_description: req.body.task_description,
      task_id: req.body.task_id,
      actor_username: user.username
    });
    const status = action === 'complete' ? 'completed' : 'skipped';
    await resolveCardMessage(req.body.message_id, status);
    res.json({ ok: true, status });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
