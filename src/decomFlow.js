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

// Deliberately not Gemini/AI-based: this trigger must not depend on an external service's
// uptime (Gemini's own "high demand" 503s were causing real, confusing failures here). Every
// real-world message in the decom channel has followed the same "decommission <hostname>"
// shape, so a plain, local, instant regex match covers it — case-insensitive, tolerant of a
// leading "please"/"can you" etc. since it just looks for the word anywhere. The token after
// it must contain a digit (a lookahead, not just part of the character class) — every real
// hostname seen in practice has one (TESTVM01, PRD-WEB-01), and requiring it avoids false
// positives on ordinary English words in a sentence that happens to mention "decommission".
const DECOM_PATTERN = /\bdecommission(?:ing)?\b\s*:?\s*((?=[A-Za-z0-9._-]*[0-9])[A-Za-z0-9][A-Za-z0-9._-]*)/i;

function extractDecomIntent(text) {
  const match = text.match(DECOM_PATTERN);
  if (!match) return null;
  return { hostname: match[1] };
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
// NovaDesk hiccup here must not affect the human's own message send.
async function handleDecomTrigger(channelId, userId, text) {
  try {
    const intent = extractDecomIntent(text);
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
