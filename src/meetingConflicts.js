// Calendar conflict warnings: which meetings already fill the time of a meeting being planned, for
// each person invited (and the organizer), or for you when you open an invitation. A warning, never
// a refusal: the meeting can still be sent.
//
// A meeting fills someone's time when it is shown as busy and they haven't declined it (accepted,
// tentative and unanswered all count, as in Outlook). Free/busy only for other people: the title
// of someone else's meeting is shown only when you are invited to it too.
// Times are UTC 'YYYY-MM-DD HH:MM:SS' text (meetings.start_at / end_at), which compare as text.
const { db } = require('./db');

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// Pure: the planned occurrences against the busy meetings found, grouped per person (you first, then
// by name), each person's overlaps in time order.
function groupConflicts(occurrences, busy, people, viewerId, viewerMeetingIds) {
  const byPerson = new Map();
  for (const occ of occurrences) {
    for (const b of busy) {
      if (!overlaps(occ.start_at, occ.end_at, b.start_at, b.end_at)) continue;
      if (!byPerson.has(b.user_id)) byPerson.set(b.user_id, []);
      const list = byPerson.get(b.user_id);
      if (list.some(x => x.meeting_id === b.meeting_id && x.occurrence_start === occ.start_at)) continue;
      list.push({
        occurrence_start: occ.start_at, meeting_id: b.meeting_id, start_at: b.start_at, end_at: b.end_at, all_day: !!Number(b.all_day),
        title: viewerMeetingIds.has(b.meeting_id) ? b.title : null,
      });
    }
  }
  const out = [];
  for (const p of people) {
    const items = byPerson.get(p.id);
    if (!items) continue;
    items.sort((a, b) => (a.start_at < b.start_at ? -1 : a.start_at > b.start_at ? 1 : 0));
    out.push({ user_id: p.id, full_name: p.full_name, is_me: p.id === viewerId, occurrences_affected: new Set(items.map(i => i.occurrence_start)).size, items });
  }
  return out.sort((a, b) => (b.is_me - a.is_me) || a.full_name.localeCompare(b.full_name));
}

// occurrences: [{ start_at, end_at }] (UTC text); userIds: everyone to check; excludeMeetingId: the
// meeting being looked at itself.
async function findConflicts({ occurrences, userIds, viewerId, excludeMeetingId = null }) {
  if (!occurrences.length || !userIds.length) return [];
  const from = occurrences.reduce((m, o) => (o.start_at < m ? o.start_at : m), occurrences[0].start_at);
  const to = occurrences.reduce((m, o) => (o.end_at > m ? o.end_at : m), occurrences[0].end_at);
  const ids = [...new Set(userIds)];
  const list = ids.map(() => '?').join(',');
  const busy = await db.prepare(`
    SELECT a.user_id, m.id AS meeting_id, m.title, m.start_at, m.end_at, m.all_day
    FROM meeting_attendees a JOIN meetings m ON m.id = a.meeting_id
    WHERE a.user_id IN (${list}) AND a.response <> 'declined' AND m.show_as = 'busy'
      AND m.start_at < ? AND m.end_at > ? AND m.id <> ?
    ORDER BY m.start_at LIMIT 2000
  `).all(...ids, to, from, excludeMeetingId || 0);
  if (!busy.length) return [];
  const mine = await db.prepare(`SELECT meeting_id FROM meeting_attendees WHERE user_id = ? AND meeting_id IN (${[...new Set(busy.map(b => b.meeting_id))].map(() => '?').join(',')})`)
    .all(viewerId, ...new Set(busy.map(b => b.meeting_id)));
  const people = await db.prepare(`SELECT id, full_name FROM users WHERE id IN (${list})`).all(...ids);
  return groupConflicts(occurrences, busy, people, viewerId, new Set(mine.map(r => r.meeting_id)));
}

module.exports = { findConflicts, groupConflicts, overlaps };
