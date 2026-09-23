const createAsyncRouter = require('../asyncRouter');
const { requireAuth } = require('../middleware/auth');
const { callNovaDesk } = require('../decomFlow');
const { resolveDecomCardByMessageId } = require('../decomCards');
const { db } = require('../db');

const router = createAsyncRouter();
router.use(requireAuth);

// All routes below are relative — this router is mounted at app.use('/api/decom', ...) in
// server.js, not '/'. Mounting a router with its own router.use(requireAuth) gate at '/' was
// the exact bug behind the earlier NovaDesk outage (see server-decom-workflow memory) — it
// silently intercepts every request reaching the app, including unrelated routers mounted
// afterward. That's precisely what happened here: this router being mounted at '/' with full
// '/api/decom/...' paths was catching requests meant for the separate
// '/api/integrations/novadesk/decom-updates' router mounted later in server.js, rejecting them
// with 401 "Not signed in." before they ever reached it. Fixed 2026-09-21.
// NovaDesk's own approve handler now resolves the approval card and posts the "✅ approved by
// X" confirmation itself, as the very first thing it does after the DB write — before posting
// the precheck cards. That's deliberate: this whole relay blocks on callNovaDesk, so if this
// route did that resolve+post itself (as it used to), it would only happen *after* NovaDesk's
// entire approve handler already finished, landing dead last in the visible order — after the
// precheck cards — even though "approved" is logically the first thing that happens. So this
// route no longer duplicates that; it just relays and returns.
router.post('/:changeId/approve', async (req, res) => {
  const user = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(req.session.user.id);

  try {
    const { change } = await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/approve`, {
      approved_by_username: user.username
    });
    res.json({ ok: true, change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// NovaDesk's own reject handler now resolves the approval card and posts the "❌ rejected"
// confirmation itself (same reasoning as approve above), since a Change can also be rejected
// directly from NovaDesk's own UI, not only from here.
router.post('/:changeId/reject', async (req, res) => {
  const user = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(req.session.user.id);

  try {
    const { change } = await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/reject`, {
      rejected_by_username: user.username
    });
    res.json({ ok: true, change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The second checkpoint's action route. NovaDesk's own confirm-destroy handler now resolves
// the decom_confirm_destroy card itself (same reasoning as approve/reject/precheck-task above)
// — this was found missing when a confirm-destroy driven directly through NovaDesk's endpoint
// (bypassing this route entirely) left the card stuck showing "Confirm Destroy" with live
// buttons even though the VM had genuinely been destroyed. This route no longer duplicates
// that resolve. NovaDesk itself pushes the final completion message once destroy actually
// finishes, so no postBotMessage call here either.
router.post('/:changeId/confirm-destroy', async (req, res) => {
  const user = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(req.session.user.id);

  try {
    const { change } = await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/confirm-destroy`, {
      confirmed_by_username: user.username
    });
    res.json({ ok: true, change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cancel option next to Confirm Destroy — backs out at the last checkpoint instead of
// proceeding. NovaDesk's own cancel-destroy handler now resolves the card itself too (same
// fix as confirm-destroy above), and pushes its own "cancelled, powered back on" status
// message once done.
router.post('/:changeId/cancel-destroy', async (req, res) => {
  const user = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(req.session.user.id);

  try {
    const { change } = await callNovaDesk(`/api/integrations/novaconnect/decommission-requests/${req.params.changeId}/cancel-destroy`, {
      cancelled_by_username: user.username
    });
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
    await resolveDecomCardByMessageId(req.body.message_id, 'skipped');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Individual pre-check confirmation prompt action: Complete or Skip. NovaDesk's precheck-task
// handler now resolves this card itself, before it (possibly) triggers power-down if this was
// the last of the 3 — same ordering reasoning as approve/reject above. This route no longer
// duplicates that resolve.
router.post('/:changeId/precheck-task', async (req, res) => {
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
    res.json({ ok: true, status });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
