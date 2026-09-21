const createAsyncRouter = require('../asyncRouter');
const { db, nowStr } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = createAsyncRouter();
router.use(requireAuth);

async function isTeamMember(teamId, userId) {
  return !!(await db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId));
}
async function isTeamOwner(teamId, userId) {
  const row = await db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  return !!row && row.role === 'owner';
}

// Returns every event from every team the user belongs to, whose start falls within
// [start, end) — the client passes the visible month grid's date range (which spans a
// little into the adjacent months to fill the leading/trailing grid cells).
router.get('/api/calendar/events', async (req, res) => {
  const start = req.query.start;
  const end = req.query.end;
  if (!start || !end) return res.status(400).json({ error: 'start and end are required (YYYY-MM-DD).' });

  const rows = await db.prepare(`
    SELECT e.*, t.name AS team_name, t.icon AS team_icon
    FROM calendar_events e
    JOIN teams t ON t.id = e.team_id
    JOIN team_members tm ON tm.team_id = e.team_id AND tm.user_id = ?
    WHERE e.start_at >= ? AND e.start_at < ?
    ORDER BY e.start_at ASC
  `).all(req.session.user.id, start + ' 00:00:00', end + ' 00:00:00');

  const meetings = await db.prepare(`SELECT m.*, m.id AS meeting_id, 'Meeting' AS team_name, 'bi-calendar-event' AS team_icon, NULL AS team_id
    FROM meetings m JOIN meeting_attendees a ON a.meeting_id=m.id
    WHERE a.user_id=? AND a.response != 'declined' AND m.start_at < ? AND m.end_at >= ? ORDER BY m.start_at`)
    .all(req.session.user.id, end + ' 23:59:59', start + ' 00:00:00');
  res.json({ events: [...rows, ...meetings.map(m => ({...m,id:'meeting-'+m.id}))] });
});

router.post('/api/calendar/events', async (req, res) => {
  const { team_id, title, description, location, start_at, end_at } = req.body;
  const allDay = req.body.all_day ? 1 : 0;

  if (!team_id || !(await isTeamMember(team_id, req.session.user.id))) {
    return res.status(403).json({ error: 'Not a member of this team.' });
  }
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required.' });
  if (!start_at || !end_at) return res.status(400).json({ error: 'Start and end are required.' });
  if (end_at < start_at) return res.status(400).json({ error: 'End time must be after the start time.' });

  const event = await db.prepare(`
    INSERT INTO calendar_events (team_id, title, description, location, start_at, end_at, all_day, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *
  `).get(team_id, title.trim(), description || null, location || null, start_at, end_at, allDay, req.session.user.id, nowStr(), nowStr());

  const team = await db.prepare('SELECT name, icon FROM teams WHERE id = ?').get(team_id);
  res.status(201).json({ ...event, team_name: team.name, team_icon: team.icon });
});

async function loadEventForEdit(id, userId) {
  const event = await db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
  if (!event) return { error: 404, message: 'Event not found.' };
  if (!(await isTeamMember(event.team_id, userId))) return { error: 403, message: 'Not a member of this team.' };
  const canManage = event.created_by === userId || (await isTeamOwner(event.team_id, userId));
  if (!canManage) return { error: 403, message: 'Only the organizer or a team owner can change this event.' };
  return { event };
}

router.put('/api/calendar/events/:id', async (req, res) => {
  const { event, error, message } = await loadEventForEdit(req.params.id, req.session.user.id);
  if (error) return res.status(error).json({ error: message });

  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const start_at = req.body.start_at || event.start_at;
  const end_at = req.body.end_at || event.end_at;
  if (end_at < start_at) return res.status(400).json({ error: 'End time must be after the start time.' });

  const updated = await db.prepare(`
    UPDATE calendar_events SET title = ?, description = ?, location = ?, start_at = ?, end_at = ?, all_day = ?, updated_at = ?
    WHERE id = ? RETURNING *
  `).get(title, req.body.description || null, req.body.location || null, start_at, end_at, req.body.all_day ? 1 : 0, nowStr(), event.id);

  const team = await db.prepare('SELECT name, icon FROM teams WHERE id = ?').get(updated.team_id);
  res.json({ ...updated, team_name: team.name, team_icon: team.icon });
});

router.delete('/api/calendar/events/:id', async (req, res) => {
  const { event, error, message } = await loadEventForEdit(req.params.id, req.session.user.id);
  if (error) return res.status(error).json({ error: message });
  await db.prepare('DELETE FROM calendar_events WHERE id = ?').run(event.id);
  res.json({ ok: true });
});

module.exports = router;
