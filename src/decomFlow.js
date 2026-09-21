const { db, nowStr } = require('./db');
const { emitToChannel } = require('./realtime');
const { hydrateOne } = require('./messageUtils');

// host.containers.internal, not NovaDesk's raw pod IP (10.0.0.101): that IP also happens to
// carry this host's default gateway (enp10s0), which hits an asymmetric pasta hairpin-NAT
// edge case — peer-pod-to-peer-pod calls targeting the gateway-carrying interface get
// ECONNREFUSED, while the same call to a non-gateway peer IP (10.0.0.102) works fine, and a
// plain "reach the host" call via host.containers.internal works fine in both directions.
// Confirmed empirically 2026-09-21; do not swap this back to a raw peer IP.
const NOVADESK_BASE_URL = process.env.NOVADESK_BASE_URL || 'http://host.containers.internal';
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Returns { hostname } for a decommission request, null if the message genuinely isn't
// one, or throws if Gemini itself couldn't be reached/answer (distinct from "not a match")
// so the caller can tell a real transient failure apart from silence being the right call.
async function extractDecomIntent(text) {
  const { callGemini, apiKey } = getGemini();
  if (!apiKey) return null;

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
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
      lastError = e;
      // Gemini's own "high demand" 503s are explicitly transient — one short retry
      // absorbs most of them instead of surfacing an error for something self-resolving.
      if (attempt === 1 && /50[0-9]/.test(e.message)) { await sleep(1500); continue; }
      break;
    }
  }
  console.error('Decom intent extraction failed:', lastError.message);
  throw lastError;
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
    let intent;
    try {
      intent = await extractDecomIntent(text);
    } catch (e) {
      // A genuine Gemini failure (as opposed to Gemini correctly saying "not a
      // decommission request") must not fail silently — silence looks identical to
      // "nothing happened" and hides that the request needs to just be retried.
      await postBotMessage(channelId, `⚠️ Couldn't process that message — Gemini is temporarily unavailable (${e.message}). Try again in a moment.`);
      return;
    }
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
