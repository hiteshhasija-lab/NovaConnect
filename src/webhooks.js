// Incoming webhooks (Extensibility): a channel's secret URL, POST /hooks/<id>/<secret>, that other
// systems (monitoring, CI, NovaDesk-like tools) post messages to. Team owners and admins make and
// revoke them from the channel header (routes/webhooks.js); every one is in the audit log.
//
// Accepted bodies (JSON): { "text": "..." } (the shape Slack-style tools send) or { "body": "..." },
// up to 4000 characters, with an optional "title" (shown in bold above the text). The message is
// written by the shared "Incoming webhook" account (inactive: it can't sign in and isn't in people
// search) and shows the webhook's own name as its author. It is a normal channel post otherwise:
// delivered live, searchable, @mentions notify, retention and legal hold apply.
const crypto = require('crypto');
const { db } = require('./db');

const WEBHOOK_USERNAME = 'incoming-webhook';
const TEXT_MAX = 4000;
const TITLE_MAX = 200;
const NAME_MAX = 80;

const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');
function newSecret() { return crypto.randomBytes(24).toString('base64url'); }

// Constant-time comparison of a presented secret with the stored hash.
function secretMatches(secret, storedHash) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(secret) || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashSecret(secret), 'hex'), b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The posted JSON as message text: { error } or { value: body }.
function parsePayload(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const text = typeof p.text === 'string' ? p.text : typeof p.body === 'string' ? p.body : '';
  const title = typeof p.title === 'string' ? p.title.replace(/\s+/g, ' ').trim() : '';
  if (!text.trim() && !title) return { error: 'Send JSON with "text" (or "body"), and optionally "title".' };
  if (text.length > TEXT_MAX) return { error: `"text" is longer than ${TEXT_MAX} characters.` };
  if (title.length > TITLE_MAX) return { error: `"title" is longer than ${TITLE_MAX} characters.` };
  return { value: [title ? `**${title}**` : '', text.trim()].filter(Boolean).join('\n') };
}

function parseName(raw) {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name || name.length > NAME_MAX) return { error: `Give the webhook a name of up to ${NAME_MAX} characters (people see it as the author).` };
  return { value: name };
}

// The shared account webhook messages are written by (made on first use; inactive, unusable password).
async function webhookUserId() {
  const found = await db.prepare('SELECT id FROM users WHERE username = ?').get(WEBHOOK_USERNAME);
  if (found) return found.id;
  const unusable = '!' + crypto.randomBytes(32).toString('hex');   // not a bcrypt hash: no password can match it
  await db.prepare(`
    INSERT INTO users (username, password_hash, full_name, role, title, status, active) VALUES (?, ?, 'Incoming webhook', 'member', 'Posts from other systems', 'offline', 0)
    ON CONFLICT (username) DO NOTHING
  `).run(WEBHOOK_USERNAME, unusable);
  return (await db.prepare('SELECT id FROM users WHERE username = ?').get(WEBHOOK_USERNAME)).id;
}

module.exports = { hashSecret, newSecret, secretMatches, parsePayload, parseName, webhookUserId, WEBHOOK_USERNAME, TEXT_MAX };
