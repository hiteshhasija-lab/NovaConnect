const createAsyncRouter = require('../asyncRouter');
const { randomUUID, randomBytes } = require('node:crypto');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { emitToUser, touchPresence } = require('../realtime');
const { occurrences } = require('../meeting-time');
const { findConflicts } = require('../meetingConflicts');
const { actingFor } = require('../delegates');
const router = createAsyncRouter();
router.use(requireAuth);
// Every route below may act for someone who made you their calendar delegate (src/delegates.js):
// on_behalf_of in the body, or ?for= on reads and cancelling.
router.post('/api/meetings', async (req,res) => {
  const me = req.session.user.id, b = req.body;
  const acting = await actingFor(req, b.on_behalf_of);
  if (acting.error) return res.status(acting.status).json({ error: acting.error });
  const userId = acting.id;   // the organizer: you, or whoever you are a delegate for
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 200) return res.status(400).json({ error:'Enter a title of up to 200 characters.' });
  if (!Array.isArray(b.attendee_ids) || !b.attendee_ids.length || b.attendee_ids.length > 50 || b.attendee_ids.some(id => !Number.isSafeInteger(id) || id < 1)) return res.status(400).json({ error:'Choose 1–50 attendees.' });
  if (typeof b.details !== 'string' || b.details.length > 20000 || typeof b.location !== 'string' || b.location.length > 500) return res.status(400).json({ error:'Meeting details or location are too long.' });
  if (typeof b.all_day !== 'boolean' || typeof b.request_rsvp !== 'boolean') return res.status(400).json({ error:'Invalid meeting options.' });
  if (!['busy','free'].includes(b.show_as)) return res.status(400).json({ error:'Invalid availability.' });
  const conversationId = b.conversation_id == null ? null : Number(b.conversation_id);
  if(conversationId!==null){
    if(!Number.isSafeInteger(conversationId))return res.status(400).json({error:'Invalid conversation.'});
    const membership=await db.prepare('SELECT 1 FROM dm_participants WHERE conversation_id=? AND user_id=?').get(conversationId,me);
    if(!membership)return res.status(403).json({error:'You are not part of this conversation.'});
  }
  const attendees = [...new Set([userId,...b.attendee_ids])];
  const people = await db.prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${attendees.map(()=>'?').join(',')})`).all(...attendees);
  if (people.length !== attendees.length) return res.status(400).json({ error:'An attendee is no longer available.' });
  let dates;
  try { dates = occurrences(b); } catch(e) { return res.status(400).json({error:e.message}); }
  if (b.all_day && (b.start_local.slice(11) !== '00:00' || b.end_local.slice(11) !== '00:00')) return res.status(400).json({ error:'All-day dates must start and end at midnight.' });
  const series = randomUUID();
  const saved = await db.transaction(async trx => {
    const ids = [];
    const meetCode=randomBytes(12).toString('hex');
    await trx('meet_links').insert({code:meetCode,title,created_by:userId});
    for (const date of dates) {
      const [m] = await trx('meetings').insert({ title, details:b.details, location:b.location, timezone:b.timezone, all_day:b.all_day ? 1:0, request_rsvp:b.request_rsvp ? 1:0, show_as:b.show_as, created_by:userId, scheduled_by:acting.self ? null : me, meet_code:meetCode, conversation_id:conversationId, series_id:series, ...date }).returning('id');
      ids.push(m.id);
      await trx('meeting_attendees').insert(attendees.map(id=>({meeting_id:m.id,user_id:id,response:id===userId?'accepted':'pending'})));
    }
    const delegateName = acting.self ? null : (req.session.user.full_name || req.session.user.username);
    for (const id of attendees.filter(id=>id!==userId)) {
      await trx('notifications').insert({user_id:id,type:'meeting',actor_id:userId,meeting_id:ids[0],body:title + (ids.length>1 ? ` (${ids.length} occurrences)` : '') + (delegateName ? ` · sent by ${delegateName}` : '')});
    }
    // The organizer hears that their delegate sent a meeting for them.
    if (delegateName) await trx('notifications').insert({user_id:userId,type:'delegate',actor_id:me,meeting_id:ids[0],body:`Sent "${title}" for you`});
    return ids;
  });
  attendees.forEach(id => emitToUser(id,'notification:new',{}));
  // A meeting that is on right now changes who shows "In a meeting" (presenceRules.js).
  attendees.forEach(touchPresence);
  res.status(201).json({id:saved[0],count:saved.length});
});
// Conflict warnings for a meeting being planned (the new-meeting form asks as times and people change):
// the same time fields as POST /api/meetings, every occurrence checked, for the attendees and you.
router.post('/api/meetings/conflicts', async (req, res) => {
  const b = req.body || {};
  const acting = await actingFor(req, b.on_behalf_of);
  if (acting.error) return res.status(acting.status).json({ error: acting.error });
  const userId = acting.id;
  const ids = Array.isArray(b.attendee_ids) ? b.attendee_ids : [];
  if (ids.length > 50 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) return res.status(400).json({ error: 'Choose 1–50 attendees.' });
  if (typeof b.all_day !== 'boolean') return res.status(400).json({ error: 'Invalid meeting options.' });
  let dates;
  try { dates = occurrences(b); } catch (e) { return res.status(400).json({ error: e.message }); }
  const people = await findConflicts({ occurrences: dates, userIds: [userId, ...ids], viewerId: userId });
  res.json({ conflicts: people, occurrences: dates.length });
});
router.get('/api/meetings/:id', async(req,res)=>{
  const acting = await actingFor(req, req.query.for);
  if (acting.error) return res.status(acting.status).json({ error: acting.error });
  const meeting = await db.prepare('SELECT m.*, a.response, u.full_name AS organizer, s.full_name AS scheduled_by_name FROM meetings m JOIN meeting_attendees a ON a.meeting_id=m.id JOIN users u ON u.id=m.created_by LEFT JOIN users s ON s.id=m.scheduled_by WHERE m.id=? AND a.user_id=?').get(req.params.id,acting.id);
  if (!meeting) return res.status(404).json({error:'Meeting not found.'});
  meeting.viewing_for = acting.self ? null : acting.id;
  const attendees = await db.prepare('SELECT u.id,u.full_name,a.response FROM meeting_attendees a JOIN users u ON u.id=a.user_id WHERE a.meeting_id=? ORDER BY u.full_name').all(meeting.id);
  // Your own other meetings at the same time (before you answer the invitation).
  const conflicts = (await findConflicts({ occurrences: [{ start_at: meeting.start_at, end_at: meeting.end_at }], userIds: [acting.id], viewerId: acting.id, excludeMeetingId: meeting.id }))[0]?.items || [];
  res.json({meeting,attendees,conflicts});
});
router.post('/api/meetings/:id/response',async(req,res)=>{
  if(!['accepted','declined','tentative'].includes(req.body.response)) return res.status(400).json({error:'Invalid response.'});
  const acting = await actingFor(req, req.body.on_behalf_of);
  if (acting.error) return res.status(acting.status).json({ error: acting.error });
  const row=await db.prepare('UPDATE meeting_attendees SET response=? WHERE meeting_id=? AND user_id=? RETURNING meeting_id').get(req.body.response,req.params.id,acting.id);
  if(!row) return res.status(404).json({error:'Meeting not found.'});
  touchPresence(acting.id);
  // Answered by a delegate: the person it was for is told.
  if (!acting.self) {
    const m = await db.prepare('SELECT title FROM meetings WHERE id=?').get(row.meeting_id);
    await db.prepare(`INSERT INTO notifications (user_id, type, actor_id, meeting_id, body) VALUES (?, 'delegate', ?, ?, ?)`)
      .run(acting.id, req.session.user.id, row.meeting_id, `${req.body.response[0].toUpperCase() + req.body.response.slice(1)} "${m?.title || 'a meeting'}" for you`);
    emitToUser(acting.id, 'notification:new', {});
  }
  res.json({ok:true});
});
router.delete('/api/meetings/:id',async(req,res)=>{
  const acting = await actingFor(req, req.query.for);
  if (acting.error) return res.status(acting.status).json({ error: acting.error });
  const attendees=await db.prepare('SELECT user_id FROM meeting_attendees WHERE meeting_id=?').all(req.params.id);
  const result=await db.prepare('DELETE FROM meetings WHERE id=? AND created_by=?').run(req.params.id,acting.id);
  if(!result.changes) return res.status(403).json({error:'Only the organizer can cancel this meeting.'});
  attendees.forEach(a=>touchPresence(a.user_id));
  res.json({ok:true});
});
module.exports=router;
