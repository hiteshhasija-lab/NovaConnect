const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resyncUserRooms } = require('../realtime');

const router = createAsyncRouter();
router.use(requireAuth);

async function isTeamOwner(teamId, userId) {
  const row = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  return !!row && (row.role === 'owner' || row.role === 'admin');
}
async function isTeamMember(teamId, userId) {
  return !!(await db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId));
}

router.get('/api/teams', async (req, res) => {
  const teams = await db.prepare(`
    SELECT t.*, (tm.user_id IS NOT NULL) AS is_member, tm.role AS my_role,
      (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS member_count
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
    ORDER BY is_member DESC, t.name
  `).all(req.session.user.id);
  res.json(teams);
});

router.post('/api/teams', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Team name is required.' });
  const description = (req.body.description || '').trim() || null;
  const icon = req.body.icon || 'bi-people-fill';

  const team = await db.prepare(`
    INSERT INTO teams (name, description, icon, created_by) VALUES (?, ?, ?, ?) RETURNING *
  `).get(name, description, icon, req.session.user.id);
  await db.prepare(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')`).run(team.id, req.session.user.id);
  const channel = await db.prepare(`
    INSERT INTO channels (team_id, name, description, is_private, created_by) VALUES (?, 'general', 'Team-wide chat', 0, ?) RETURNING *
  `).get(team.id, req.session.user.id);

  res.status(201).json({ team, channel });
});

router.post('/api/teams/:id/join', async (req, res) => {
  const teamId = req.params.id;
  const team = await db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  await db.prepare(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING`)
    .run(teamId, req.session.user.id);
  await resyncUserRooms(req.session.user.id);
  res.json({ ok: true });
});

router.post('/api/teams/:id/leave', async (req, res) => {
  const teamId = req.params.id;
  const userId = req.session.user.id;
  const owners = await db.prepare(`SELECT COUNT(*) AS c FROM team_members WHERE team_id = ? AND role = 'owner'`).get(teamId);
  const mine = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  if (mine && mine.role === 'owner' && Number(owners.c) <= 1) {
    return res.status(400).json({ error: 'You are the only owner — promote someone else first or delete the team.' });
  }
  await db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
  await db.prepare('DELETE FROM channel_members WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE team_id = ?)').run(userId, teamId);
  await resyncUserRooms(userId);
  res.json({ ok: true });
});

router.get('/api/teams/:id', async (req, res) => {
  const teamId = req.params.id;
  const userId = req.session.user.id;
  if (!(await isTeamMember(teamId, userId))) return res.status(403).json({ error: 'Not a member of this team.' });

  const team = await db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Team not found.' });

  const channels = await db.prepare(`
    SELECT c.* FROM channels c
    WHERE c.team_id = ? AND (c.is_private = 0 OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
    ORDER BY c.name
  `).all(teamId, userId);

  res.json({ team, channels });
});

router.get('/api/teams/:id/members', async (req, res) => {
  const teamId = req.params.id;
  if (!(await isTeamMember(teamId, req.session.user.id))) return res.status(403).json({ error: 'Not a member of this team.' });
  const members = await db.prepare(`
    SELECT u.id, u.full_name, u.username, u.title, u.status, tm.role
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.team_id = ? ORDER BY tm.role = 'owner' DESC, u.full_name
  `).all(teamId);
  res.json(members);
});

router.post('/api/teams/:id/members', async (req, res) => {
  const teamId = req.params.id;
  if (!(await isTeamOwner(teamId, req.session.user.id))) return res.status(403).json({ error: 'Only a team owner can add members.' });
  const username = (req.body.username || '').trim();
  const user = await db.prepare('SELECT id FROM users WHERE username = ? AND active = 1').get(username);
  if (!user) return res.status(404).json({ error: `No active user found with username "${username}".` });
  await db.prepare(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member') ON CONFLICT DO NOTHING`)
    .run(teamId, user.id);
  await resyncUserRooms(user.id);
  res.status(201).json({ ok: true });
});

router.delete('/api/teams/:id/members/:userId', async (req, res) => {
  const teamId = req.params.id;
  const targetId = Number(req.params.userId);
  const isSelf = targetId === req.session.user.id;
  if (!isSelf && !(await isTeamOwner(teamId, req.session.user.id))) {
    return res.status(403).json({ error: 'Only a team owner can remove other members.' });
  }
  await db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, targetId);
  await db.prepare('DELETE FROM channel_members WHERE user_id = ? AND channel_id IN (SELECT id FROM channels WHERE team_id = ?)').run(targetId, teamId);
  await resyncUserRooms(targetId);
  res.json({ ok: true });
});

router.post('/api/teams/:id/channels', async (req, res) => {
  const teamId = req.params.id;
  const userId = req.session.user.id;
  if (!(await isTeamMember(teamId, userId))) return res.status(403).json({ error: 'Not a member of this team.' });

  const name = (req.body.name || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (!name) return res.status(400).json({ error: 'Channel name is required.' });
  const description = (req.body.description || '').trim() || null;
  const isPrivate = req.body.is_private ? 1 : 0;

  let channel;
  try {
    channel = await db.prepare(`
      INSERT INTO channels (team_id, name, description, is_private, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *
    `).get(teamId, name, description, isPrivate, userId);
  } catch (e) {
    return res.status(400).json({ error: `A channel named "#${name}" already exists in this team.` });
  }
  if (isPrivate) {
    await db.prepare(`INSERT INTO channel_members (channel_id, user_id) VALUES (?, ?)`).run(channel.id, userId);
  }
  await resyncUserRooms(userId);
  res.status(201).json(channel);
});

router.get('/api/channels/:id', async (req, res) => {
  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  const userId = req.session.user.id;
  const member = await isTeamMember(channel.team_id, userId);
  if (!member) return res.status(403).json({ error: 'Not a member of this team.' });
  if (channel.is_private) {
    const inChannel = await db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
    if (!inChannel) return res.status(403).json({ error: 'This is a private channel.' });
  }
  const members = channel.is_private
    ? await db.prepare(`
        SELECT u.id, u.full_name, u.username FROM channel_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.channel_id = ? ORDER BY u.full_name
      `).all(channel.id)
    : await db.prepare(`
        SELECT u.id, u.full_name, u.username FROM team_members tm JOIN users u ON u.id = tm.user_id
        WHERE tm.team_id = ? ORDER BY u.full_name
      `).all(channel.team_id);
  res.json({ channel, members });
});

module.exports = router;
