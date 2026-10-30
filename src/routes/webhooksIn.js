// Incoming webhooks (src/webhooks.js): the endpoint other systems post to, POST /hooks/<id>/<secret>.
// No session: the URL's secret is the credential. server.js mounts this at /hooks before the session
// and every signed-in router, like /api/integrations (see the note there). Managing webhooks is
// routes/webhooks.js.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, nowStr } = require('../db');
const { hydrateOne } = require('../messageUtils');
const { emitToChannel } = require('../realtime');
const { indexMessage } = require('../search');
const { recordMentions, channelMemberIds } = require('./messages');
const hooks = require('../webhooks');

const router = express.Router();
// 30 posts a minute per webhook (a noisy alert source can't flood a channel), plus the global limit.
const perHook = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => 'hook:' + req.params.id,
  handler: (req, res) => res.status(429).json({ error: 'Too many posts from this webhook; try again in a minute.' }),
});
const notFound = (res) => res.status(404).json({ error: 'No such webhook.' });
router.post('/:id/:secret', perHook, express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    const hook = await db.prepare('SELECT w.*, c.name AS channel_name, c.team_id FROM channel_webhooks w JOIN channels c ON c.id = w.channel_id WHERE w.id = ? AND w.revoked_at IS NULL')
      .get(Number(req.params.id) || 0);
    if (!hook || !hooks.secretMatches(req.params.secret, hook.secret_hash)) return notFound(res);
    const parsed = hooks.parsePayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const authorId = await hooks.webhookUserId();
    const now = nowStr();
    const row = await db.prepare(`
      INSERT INTO messages (channel_id, user_id, body, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *
    `).get(hook.channel_id, authorId, parsed.value, JSON.stringify({ webhook: { id: hook.id, name: hook.name } }), now, now);
    await db.prepare('UPDATE channel_webhooks SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?').run(now, hook.id);

    const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(hook.channel_id);
    const memberIds = await channelMemberIds(channel);
    const memberRows = memberIds.length ? await db.prepare(`SELECT id, full_name FROM users WHERE id IN (${memberIds.map(() => '?').join(',')})`).all(...memberIds) : [];
    await recordMentions({ body: parsed.value, authorId, memberRows, channelId: channel.id, conversationId: null, messageId: row.id });
    const message = await hydrateOne(row, null);
    emitToChannel(channel.id, 'message:new', message);
    res.status(200).json({ ok: true, message_id: row.id });

    const team = channel.team_id ? await db.prepare('SELECT id FROM teams WHERE id = ?').get(channel.team_id) : null;
    indexMessage(row, { full_name: hook.name }, channel, null, team).catch(() => {});
  } catch (e) { next(e); }
});
// Anything else under /hooks (a GET in a browser, a malformed URL): the same answer as a wrong secret.
router.use((req, res) => notFound(res));

module.exports = router;
