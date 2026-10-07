const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { hydrateOne } = require('../messageUtils');
const { emitToChannel, emitToConversation } = require('../realtime');
const { resolveDecomCards } = require('../decomCards');

const router = createAsyncRouter();

// Same Bearer-shared-secret pattern as NovaDesk's integrations.js requireSyncAuth. This router
// MUST stay mounted at its own path prefix (/api/integrations), never at '/' — a router-wide
// auth gate mounted at '/' took down the whole NovaDesk app for hours once already (see
// server-decom-workflow memory). Do not repeat that mistake here.
function requireSyncAuth(req, res, next) {
  const expected = process.env.SYNC_API_KEY;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ error: 'Missing or invalid service credentials.' });
  }
  next();
}
router.use(requireSyncAuth);

// POST /api/integrations/novadesk/decom-updates
// body: { channel_id, conversation_id, body, metadata, idempotency_key? } — exactly one of
// channel_id/conversation_id, matching whichever surface (server-decom channel, or a DM with
// novadesk-bot) the originating Change was created from.
//
// idempotency_key (optional, from NovaDesk's card ledger): posting the same key again never stores
// a second message; it answers 200 {duplicate: true} with the id of the first. The message is
// saved before it is built and broadcast, so a failed answer (5xx, timeout) can still mean "saved":
// without the key NovaDesk's retry showed such a card twice. Posts without a key behave as before.
router.post('/novadesk/decom-updates', async (req, res) => {
  const { channel_id, conversation_id, body, metadata } = req.body;
  if (!channel_id && !conversation_id) return res.status(400).json({ error: 'channel_id or conversation_id is required.' });
  if (!body) return res.status(400).json({ error: 'body is required.' });
  const idempotencyKey = typeof req.body.idempotency_key === 'string' && req.body.idempotency_key.trim()
    ? req.body.idempotency_key.trim().slice(0, 300) : null;

  const bot = await db.prepare("SELECT id FROM users WHERE username = 'novadesk-bot'").get();
  const row = await db.prepare(`
    INSERT INTO messages (channel_id, conversation_id, user_id, body, metadata, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING *
  `).get(channel_id || null, conversation_id || null, bot ? bot.id : null, body, metadata ? JSON.stringify(metadata) : null, idempotencyKey, nowStr(), nowStr());
  if (!row) {
    const existing = await db.prepare('SELECT id FROM messages WHERE idempotency_key = ?').get(idempotencyKey);
    return res.status(200).json({ ok: true, keyed: true, duplicate: true, messageId: existing ? existing.id : null });
  }
  const message = await hydrateOne(row, null);
  if (channel_id) emitToChannel(channel_id, 'message:new', message);
  else emitToConversation(conversation_id, 'message:new', message);

  // keyed: true tells NovaDesk this version honours idempotency_key, so it may retry a post whose
  // answer was lost without risking a second card (an older NovaConnect never sends it).
  res.status(201).json({ ok: true, messageId: message.id, ...(idempotencyKey ? { keyed: true } : {}) });
});

// POST /api/integrations/novadesk/decom-thinking
// body: { channel_id, conversation_id, thinking } — live-only signal for the 5-7s gaps where
// real work is happening server-side (ESXi power-off, ESXi destroy) but nothing has been posted
// as a message yet. Never persisted to the messages table — just relayed straight to whoever has
// that channel/DM open, via the same 'bot:thinking' event decomFlow.js emits locally for the
// CI-lookup gap, so the client only needs one listener regardless of which side triggered it.
router.post('/novadesk/decom-thinking', async (req, res) => {
  const { channel_id, conversation_id, thinking } = req.body;
  if (!channel_id && !conversation_id) return res.status(400).json({ error: 'channel_id or conversation_id is required.' });

  if (channel_id) emitToChannel(channel_id, 'bot:thinking', { scope: 'channel', id: Number(channel_id), thinking: !!thinking });
  else emitToConversation(conversation_id, 'bot:thinking', { scope: 'dm', id: Number(conversation_id), thinking: !!thinking });

  res.json({ ok: true });
});

// POST /api/integrations/novadesk/decom-updates/resolve
// body: { changeId, cardType, taskId, status } — lets a status change made directly in NovaDesk
// (the Change Tasks toggle button, not a click on a card here) resolve every copy of the
// matching card in this app — DM and server-decom broadcast alike — instead of leaving them
// stuck showing "pending" with active buttons. Identified by key, not a message id: NovaDesk
// never needs to track NovaConnect message ids at all, this app looks up every sibling itself.
router.post('/novadesk/decom-updates/resolve', async (req, res) => {
  const { changeId, cardType, taskId, status } = req.body;
  if (!changeId || !cardType || !status) return res.status(400).json({ error: 'changeId, cardType, and status are required.' });

  await resolveDecomCards({ changeId, cardType, taskId }, status);
  res.json({ ok: true });
});

module.exports = router;
