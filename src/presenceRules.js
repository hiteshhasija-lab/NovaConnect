// Which status everyone else sees for a person (users.status), from the facts realtime.js gathers.
// Pure, so the order is unit-tested on its own (test/presenceRules.test.js). Strongest first:
//
//   1. Not connected, or chose Appear offline: "Out of office" while that is on, otherwise Offline
//      (Appear offline looks exactly like being away from the app).
//   2. Chose Do not disturb: Do not disturb.
//   3. In a call or meeting right now: In a call / In a meeting / Presenting.
//   4. Out of office is on: "Out of office", unless they chose Busy (then Busy).
//   5. A meeting on their calendar right now (accepted, shown as busy, not all-day): "In a meeting",
//      but only while their status would otherwise read Available; any status they chose wins.
//   6. Every device they have open is idle (no input for 5 minutes; per-device presence): "Away",
//      again only instead of Available.
//   7. Their chosen status (Available when they never chose one or reset it).
//
// Times are the database's text format, 'YYYY-MM-DD HH:MM:SS' in UTC, which compares as text.

function isOutOfOffice(row, now) {
  if (!row || !Number(row.ooo_enabled)) return false;
  if (row.ooo_start_at && row.ooo_start_at > now) return false;
  if (row.ooo_end_at && row.ooo_end_at <= now) return false;
  return true;
}

function shownStatus({ connected, chosen, call = null, calendarMeeting = false, outOfOffice = false, idle = false }) {
  const picked = chosen || 'online';
  if (!connected || picked === 'offline') return outOfOffice ? 'ooo' : 'offline';
  if (picked === 'dnd') return 'dnd';
  if (call) return call;
  if (outOfOffice && picked !== 'busy') return 'ooo';
  if (calendarMeeting && picked === 'online') return 'inmeeting';
  if (idle && picked === 'online') return 'away';
  return picked;
}

// Which kind of device a connection comes from, by its browser's user agent: the iPhone app
// (URLSession sends CFNetwork/Darwin), the desktop app (Electron), a phone's browser, or the web.
const DEVICE_LABELS = { iphone: 'the iPhone app', desktop: 'the desktop app', mobile: 'a phone browser', web: 'the web' };
function deviceOf(userAgent) {
  const ua = String(userAgent || '');
  if (/CFNetwork|Darwin\//.test(ua) && !/Mozilla/.test(ua)) return 'iphone';
  if (/Electron\//.test(ua)) return 'desktop';
  if (/iPhone|iPad|Android|Mobile/.test(ua)) return 'mobile';
  return 'web';
}

// What other people are shown about someone's out of office: the message and when it ends, or null
// while it is off (or outside its window). Used by the profile card and chat participant lists.
function outOfOfficeSummary(row, now) {
  if (!isOutOfOffice(row, now)) return null;
  return { message: row.ooo_message || '', until: row.ooo_end_at || null };
}

// Chat participant lists (GET /api/dm/:id and the server-rendered chat page) select the raw columns
// below; this turns them into what other people may see: no expired status message, and the
// out-of-office summary instead of the settings themselves.
const PARTICIPANT_PRESENCE_COLUMNS = 'u.status_message, u.status_message_expires_at, u.ooo_enabled, u.ooo_message, u.ooo_start_at, u.ooo_end_at';
function participantPresence(p, now) {
  if (p.status_message_expires_at && p.status_message_expires_at <= now) p.status_message = null;
  p.out_of_office = outOfOfficeSummary(p, now);
  for (const k of ['status_message_expires_at', 'ooo_enabled', 'ooo_message', 'ooo_start_at', 'ooo_end_at']) delete p[k];
  return p;
}

// Checks the out-of-office form (PUT /api/profile/out-of-office). Times arrive as ISO instants
// (the browser converts its local date and time); they're stored in the database's UTC text form.
// Returns { error } or { value: { ooo_enabled, ooo_message, ooo_start_at, ooo_end_at } }.
const OOO_MESSAGE_MAX = 500;
const toDbTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function parseOutOfOffice(body, nowMs = Date.now()) {
  const b = body || {};
  if (typeof b.enabled !== 'boolean') return { error: 'Choose whether out of office is on.' };
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length > OOO_MESSAGE_MAX) return { error: `Keep the message to ${OOO_MESSAGE_MAX} characters.` };
  const time = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const ms = typeof v === 'string' ? Date.parse(v) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  };
  const start = time(b.start_at);
  const end = time(b.end_at);
  if (start === undefined || end === undefined) return { error: 'Enter a valid start and end.' };
  if (start !== null && end !== null && end <= start) return { error: 'The end has to be after the start.' };
  if (b.enabled && end !== null && end <= nowMs) return { error: 'The end is already in the past.' };
  return { value: {
    ooo_enabled: b.enabled ? 1 : 0, ooo_message: message || null,
    ooo_start_at: start === null ? null : toDbTime(start), ooo_end_at: end === null ? null : toDbTime(end)
  } };
}

// Meetings that put a person "In a meeting" (rule 5): on now, shown as busy, not all-day, and
// accepted — or not yet answered when the organizer didn't ask for replies. The organizer is an
// accepted attendee (routes/meetings.js). Two bindings: now, now.
const CALENDAR_BUSY_SQL = `
  SELECT a.user_id FROM meeting_attendees a JOIN meetings m ON m.id = a.meeting_id
  WHERE m.end_at > ? AND m.start_at <= ? AND m.all_day = 0 AND m.show_as = 'busy'
    AND (a.response = 'accepted' OR (a.response = 'pending' AND m.request_rsvp = 0))`;

module.exports = {
  isOutOfOffice, shownStatus, deviceOf, DEVICE_LABELS, outOfOfficeSummary, participantPresence, PARTICIPANT_PRESENCE_COLUMNS, parseOutOfOffice, OOO_MESSAGE_MAX, CALENDAR_BUSY_SQL
};
