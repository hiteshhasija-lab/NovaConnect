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
// body: { channel_id, conversation_id, body, metadata } — exactly one of channel_id/
// conversation_id, matching whichever surface (server-decom channel, or a DM with
// novadesk-bot) the originating Change was created from.
router.post('/novadesk/decom-updates', async (req, res) => {
  const { channel_id, conversation_id, body, metadata } = req.body;
  if (!channel_id && !conversation_id) return res.status(400).json({ error: 'channel_id or conversation_id is required.' });
  if (!body) return res.status(400).json({ error: 'body is required.' });

  const bot = await db.prepare("SELECT id FROM users WHERE username = 'novadesk-bot'").get();
  const row = await db.prepare(`
    INSERT INTO messages (channel_id, conversation_id, user_id, body, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(channel_id || null, conversation_id || null, bot ? bot.id : null, body, metadata ? JSON.stringify(metadata) : null, nowStr(), nowStr());
  const message = await hydrateOne(row, null);
  if (channel_id) emitToChannel(channel_id, 'message:new', message);
  else emitToConversation(conversation_id, 'message:new', message);

  res.status(201).json({ ok: true, messageId: message.id });
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
