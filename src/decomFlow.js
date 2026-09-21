const { db, nowStr } = require('./db');
const { emitToChannel } = require('./realtime');
const { hydrateOne } = require('./messageUtils');

const NOVADESK_BASE_URL = process.env.NOVADESK_BASE_URL || 'http://10.0.0.101';
const SYNC_API_KEY = process.env.SYNC_API_KEY || '';

// Plain HTTP, not HTTPS: this call never leaves the VM (NovaDesk and NovaConnect are
// separate podman pods on the same host), and teaching Node in this container to trust
// the mkcert CA used for the browser-facing side is unneeded complexity for it.
async function callNovaDesk(path, body) {
  const res = await fetch(`${NOVADESK_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SYNC_API_KEY}` },
    body: JSON.stringify(body || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `NovaDesk returned ${res.status}`);
  return data;
}

// Lazily required — routes/ai.js exports callGemini/GEMINI_API_KEY as properties on its
// router export in addition to being mounted as middleware; requiring it here at module
// load time (rather than inside functions) is fine since server.js already requires it
// before decomFlow.js's functions are ever called.
function getGemini() {
  const ai = require('./routes/ai');
  return { callGemini: ai.callGemini, apiKey: ai.GEMINI_API_KEY };
}

async function extractDecomIntent(text) {
  const { callGemini, apiKey } = getGemini();
  if (!apiKey) return null;
  try {
    const reply = await callGemini([{
      role: 'user',
      body: 'Extract whether this chat message is a request to decommission a server, and if so, its hostname. ' +
        'Reply with ONLY raw JSON, no markdown fences, no explanation, in exactly this shape: ' +
        '{"intent":"decommission","hostname":"..."} if it is a decommission request, or {"intent":null} otherwise.\n\n' +
        `Message: "${text}"`
    }]);
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.intent === 'decommission' && parsed.hostname) {
      return { hostname: String(parsed.hostname).trim() };
    }
    return null;
  } catch (e) {
    console.error('Decom intent extraction failed:', e.message);
    return null;
  }
}

async function postBotMessage(channelId, body, metadata) {
  const bot = await db.prepare("SELECT id FROM users WHERE username = 'novadesk-bot'").get();
  const row = await db.prepare(`
    INSERT INTO messages (channel_id, user_id, body, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(channelId, bot ? bot.id : null, body, metadata ? JSON.stringify(metadata) : null, nowStr(), nowStr());
  const message = await hydrateOne(row, null);
  emitToChannel(channelId, 'message:new', message);
  return message;
}

// Fire-and-forget from the message-post route — never let this throw upstream, since a
// Gemini/NovaDesk hiccup here must not affect the human's own message send.
async function handleDecomTrigger(channelId, userId, text) {
  try {
    const intent = await extractDecomIntent(text);
    if (!intent) return;

    const user = await db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    let result;
    try {
      result = await callNovaDesk('/api/integrations/novaconnect/decommission-requests', {
        hostname: intent.hostname,
        novaconnect_channel_id: channelId,
        requested_by_username: user ? user.username : null
      });
    } catch (e) {
      await postBotMessage(channelId, `⚠️ Couldn't start decommissioning "${intent.hostname}": ${e.message}`);
      return;
    }

    const { change, ci, esxiHost } = result;
    await postBotMessage(
      channelId,
      `🖥️ Found ${ci.name} (${ci.ci_number}) — runs on ${esxiHost.name}. Created ${change.number}: ${change.short_description}. Needs admin approval before anything happens.`,
      { cardType: 'decom_approval', changeId: change.id, changeNumber: change.number, ciName: ci.name, status: 'pending' }
    );
  } catch (e) {
    console.error('Decom trigger handling failed:', e.message);
  }
}

module.exports = { handleDecomTrigger, callNovaDesk, postBotMessage };
