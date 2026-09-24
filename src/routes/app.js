const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { hydrateMessages } = require('../messageUtils');

const router = createAsyncRouter();
router.use(requireAuth);

async function myTeamsWithChannels(userId) {
  const teams = await db.prepare(`
    SELECT t.*, tm.role AS my_role FROM teams t
    JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.name
  `).all(userId);
  for (const team of teams) {
    team.channels = await db.prepare(`
      SELECT c.* FROM channels c
      WHERE c.team_id = ? AND (c.is_private = 0 OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?))
      ORDER BY c.name
    `).all(team.id, userId);
  }
  return teams;
}

async function myConversations(userId) {
  const convos = await db.prepare(`
    SELECT dc.*, dp.is_favorite, dp.is_muted, dp.is_unread, dp.is_hidden, EXISTS (SELECT 1 FROM meetings m WHERE m.conversation_id=dc.id) AS is_meeting_chat FROM dm_conversations dc
    JOIN dm_participants dp ON dp.conversation_id = dc.id AND dp.user_id = ?
    ORDER BY dc.id DESC
  `).all(userId);
  for (const c of convos) {
    c.participants = await db.prepare(`
      SELECT u.id, u.full_name, u.username, u.status FROM dm_participants dp JOIN users u ON u.id = dp.user_id
      WHERE dp.conversation_id = ? AND dp.user_id != ?
    `).all(c.id, userId);
    c.last_message = await db.prepare(`
      SELECT m.*,u.full_name AS author_name FROM messages m LEFT JOIN users u ON u.id=m.user_id WHERE m.conversation_id = ? AND m.parent_message_id IS NULL ORDER BY m.id DESC LIMIT 1
    `).get(c.id) || null;
  }
  return convos;
}

async function renderShell(req, res, active) {
  const userId = req.session.user.id;
  const teams = await myTeamsWithChannels(userId);
  const conversations = await myConversations(userId);
  const unread = await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId);

  res.render('workspace', {
    title: 'NovaConnect',
    teams,
    conversations,
    unreadCount: Number(unread.c),
    active
  });
}

router.get('/', async (req, res) => {
  const userId = req.session.user.id;
  const firstChannel = await db.prepare(`
    SELECT c.id FROM channels c
    JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = ?
    WHERE c.is_private = 0 ORDER BY c.id LIMIT 1
  `).get(userId);
  if (firstChannel) return res.redirect(`/app/channel/${firstChannel.id}`);
  await renderShell(req, res, { type: 'none' });
});

router.get('/channel/:id', async (req, res) => {
  const userId = req.session.user.id;
  const channel = await db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!channel) return res.status(404).render('error', { title: 'Not Found', message: 'Channel not found.' });
  const member = await db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(channel.team_id, userId);
  if (!member) return res.status(403).render('error', { title: 'Access Denied', message: 'You are not a member of this team.' });
  if (channel.is_private) {
    const inChannel = await db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(channel.id, userId);
    if (!inChannel) return res.status(403).render('error', { title: 'Access Denied', message: 'This is a private channel.' });
  }

  const rows = await db.prepare(`
    SELECT * FROM messages WHERE channel_id = ? AND parent_message_id IS NULL ORDER BY id DESC LIMIT 50
  `).all(channel.id);
  const messages = await hydrateMessages(rows.reverse(), userId);
  const team = await db.prepare('SELECT * FROM teams WHERE id = ?').get(channel.team_id);

  await renderShell(req, res, { type: 'channel', channel, team, messages });
});

router.get('/dm/:id', async (req, res) => {
  const userId = req.session.user.id;
  const inConvo = await db.prepare('SELECT 1 FROM dm_participants WHERE conversation_id = ? AND user_id = ?').get(req.params.id, userId);
  if (!inConvo) return res.status(403).render('error', { title: 'Access Denied', message: 'You are not part of this conversation.' });
  const conversation = await db.prepare('SELECT * FROM dm_conversations WHERE id = ?').get(req.params.id);
  const participants = await db.prepare(`
    SELECT u.id, u.full_name, u.username, u.status, u.title, u.status_message, u.status_message_expires_at, dp.last_read_message_id
    FROM dm_participants dp JOIN users u ON u.id = dp.user_id
    WHERE dp.conversation_id = ? ORDER BY u.full_name
  `).all(conversation.id);
  const now = nowStr();
  participants.forEach(p => {
    if (p.status_message_expires_at && p.status_message_expires_at <= now) p.status_message = null;
    delete p.status_message_expires_at;
  });

  const rows = await db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? AND parent_message_id IS NULL ORDER BY id DESC LIMIT 50
  `).all(conversation.id);
  const messages = await hydrateMessages(rows.reverse(), userId);

  await renderShell(req, res, { type: 'dm', conversation, participants, messages });
});

router.get('/meet/:code', async(req,res)=>{
 const link=await db.prepare('SELECT code,title FROM meet_links WHERE code=? AND active=1').get(req.params.code);
 if(!link)return res.status(404).render('error',{title:'Meeting unavailable',message:'This meeting link does not exist.'});
 res.render('meet-room',{title:link.title,link});
});

module.exports = router;
