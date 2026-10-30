// Incoming webhooks (src/webhooks.js): managing a channel's webhooks, for team owners and admins.
// The session-less endpoint other systems post to is routes/webhooksIn.js.
const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { audit } = require('../audit');
const hooks = require('../webhooks');

const router = createAsyncRouter();
router.use('/api/channels/:id/webhooks', requireAuth);

// The channel, when the person may manage its webhooks: an owner of its team, or an admin.
async function managedChannel(req) {
  const channel = await db.prepare('SELECT c.*, t.name AS team_name FROM channels c LEFT JOIN teams t ON t.id = c.team_id WHERE c.id = ?').get(Number(req.params.id) || 0);
  if (!channel) return { status: 404, error: 'Channel not found.' };
  if (req.session.user.role === 'admin') return { channel };
  const role = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(channel.team_id, req.session.user.id);
  if (!role) return { status: 404, error: 'Channel not found.' };
  if (!['owner', 'admin'].includes(role.role)) return { status: 403, error: 'Only team owners and admins can manage webhooks.' };
  return { channel };
}
const listFor = (channelId) => db.prepare(`
  SELECT w.id, w.name, w.created_at, w.last_used_at, w.use_count, u.full_name AS created_by_name
  FROM channel_webhooks w LEFT JOIN users u ON u.id = w.created_by
  WHERE w.channel_id = ? AND w.revoked_at IS NULL ORDER BY w.id
`).all(channelId);
const hookUrl = (req, id, secret) => `${req.protocol}://${req.get('host')}/hooks/${id}/${secret}`;

router.get('/api/channels/:id/webhooks', async (req, res) => {
  const m = await managedChannel(req);
  if (m.error) return res.status(m.status).json({ error: m.error });
  res.json(await listFor(m.channel.id));
});
// Makes one; the answer carries its URL, the only time the secret is ever shown.
router.post('/api/channels/:id/webhooks', async (req, res) => {
  const m = await managedChannel(req);
  if (m.error) return res.status(m.status).json({ error: m.error });
  const name = hooks.parseName(req.body?.name);
  if (name.error) return res.status(400).json({ error: name.error });
  const count = await db.prepare('SELECT COUNT(*) AS c FROM channel_webhooks WHERE channel_id = ? AND revoked_at IS NULL').get(m.channel.id);
  if (Number(count.c) >= 20) return res.status(400).json({ error: 'A channel can have up to 20 webhooks.' });
  const secret = hooks.newSecret();
  const row = await db.prepare(`INSERT INTO channel_webhooks (channel_id, name, secret_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .get(m.channel.id, name.value, hooks.hashSecret(secret), req.session.user.id, nowStr());
  await audit(req, 'webhook.create', { targetType: 'webhook', targetId: row.id, targetName: name.value, details: { channel: '#' + m.channel.name, team: m.channel.team_name } });
  res.status(201).json({ id: row.id, name: name.value, url: hookUrl(req, row.id, secret), webhooks: await listFor(m.channel.id) });
});
router.delete('/api/channels/:id/webhooks/:hookId', async (req, res) => {
  const m = await managedChannel(req);
  if (m.error) return res.status(m.status).json({ error: m.error });
  const row = await db.prepare(`UPDATE channel_webhooks SET revoked_at = ?, revoked_by = ? WHERE id = ? AND channel_id = ? AND revoked_at IS NULL RETURNING id, name`)
    .get(nowStr(), req.session.user.id, Number(req.params.hookId) || 0, m.channel.id);
  if (!row) return res.status(404).json({ error: 'Webhook not found.' });
  await audit(req, 'webhook.revoke', { targetType: 'webhook', targetId: row.id, targetName: row.name, details: { channel: '#' + m.channel.name } });
  res.json(await listFor(m.channel.id));
});

module.exports = router;
