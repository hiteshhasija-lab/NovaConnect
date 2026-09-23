const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { hydrateOne } = require('../messageUtils');
const { emitToChannel, emitToConversation } = require('../realtime');

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

module.exports = router;
