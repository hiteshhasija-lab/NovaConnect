const { db, nowStr } = require('./db');
const { emitToChannel, emitToConversation } = require('./realtime');
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

// Deliberately not Gemini/AI-based: this trigger must not depend on an external service's
// uptime (Gemini's own "high demand" 503s were causing real, confusing failures here). Every
// real-world message in the decom channel has followed the same "decommission <hostname>"
// shape, so a plain, local, instant regex match covers it — case-insensitive, tolerant of a
// leading "please"/"can you" etc. since it just looks for the word anywhere.
//
// Originally also required the hostname token to contain a digit, on the assumption every real
// hostname would have one (TESTVM01, PRD-WEB-01) — dropped 2026-09-21 after live testing showed
// two of the real ESXi lab VMs (WIN-TEST, LINUX-TEST) don't. "decommission" itself is unusual
// enough as a deliberate word, in a channel dedicated to exactly this, to be signal enough on
// its own without the digit requirement.
const DECOM_PATTERN = /\bdecommission(?:ing)?\b\s*:?\s*([A-Za-z0-9][A-Za-z0-9._-]*)/i;

function extractDecomIntent(text) {
  const match = text.match(DECOM_PATTERN);
  if (!match) return null;
  return { hostname: match[1] };
}

// `target` is { channelId } for the server-decom channel path, or { conversationId } for a
// direct message to novadesk-bot — exactly one is set, mirroring the messages table's own
// channel_id/conversation_id convention. Every decom message (approval card, precheck cards,
// status updates) flows through this one function, so generalizing it here is what makes the
// whole pipeline work from either surface with no per-message-type changes elsewhere.
async function postBotMessage(target, body, metadata) {
  const bot = await db.prepare("SELECT id FROM users WHERE username = 'novadesk-bot'").get();
  const row = await db.prepare(`
    INSERT INTO messages (channel_id, conversation_id, user_id, body, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(target.channelId || null, target.conversationId || null, bot ? bot.id : null, body, metadata ? JSON.stringify(metadata) : null, nowStr(), nowStr());
  const message = await hydrateOne(row, null);
  if (target.channelId) emitToChannel(target.channelId, 'message:new', message);
  else emitToConversation(target.conversationId, 'message:new', message);
  return message;
}

// Fire-and-forget from the message-post route — never let this throw upstream, since a
// NovaDesk hiccup here must not affect the human's own message send.
async function handleDecomTrigger(target, userId, text) {
  try {
    const intent = extractDecomIntent(text);
    if (!intent) return;

    const user = await db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    let result;
    try {
      result = await callNovaDesk('/api/integrations/novaconnect/decommission-requests', {
        hostname: intent.hostname,
        novaconnect_channel_id: target.channelId,
        novaconnect_conversation_id: target.conversationId,
        requested_by_username: user ? user.username : null
      });
    } catch (e) {
      await postBotMessage(target, `⚠️ Couldn't start decommissioning "${intent.hostname}": ${e.message}`);
      return;
    }

    const { change, ci, esxiHost } = result;
    await postBotMessage(
      target,
      `🖥️ Found ${ci.name} (${ci.ci_number}) — runs on ${esxiHost.name}. Created ${change.number}: ${change.short_description}. Needs admin approval before anything happens.`,
      { cardType: 'decom_approval', changeId: change.id, changeNumber: change.number, ciName: ci.name, status: 'pending' }
    );
  } catch (e) {
    console.error('Decom trigger handling failed:', e.message);
  }
}

module.exports = { handleDecomTrigger, callNovaDesk, postBotMessage };
