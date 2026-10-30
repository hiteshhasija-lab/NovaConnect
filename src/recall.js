// Admin recall (Admin and compliance): an admin finds messages anywhere (by person, channel or chat,
// dates and words) and removes them for everyone with a reason (/admin/recall, routes/admin.js).
// Removal is src/messageDelete.js's, so legal hold still keeps a copy. Every search and every
// removal is in the audit log (filters and reason; never message text).

// The page's filters from the query string: { sql, params, applied } or { error }. At least one
// filter is required, so a search is always about something.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
function recallFilters(q = {}) {
  const where = ['m.deleted = 0'], params = [], applied = {};
  const person = Number(q.person);
  if (Number.isSafeInteger(person) && person > 0) { where.push('m.user_id = ?'); params.push(person); applied.person = person; }
  const channel = Number(q.channel);
  if (Number.isSafeInteger(channel) && channel > 0) { where.push('m.channel_id = ?'); params.push(channel); applied.channel = channel; }
  const chat = Number(q.chat);
  if (Number.isSafeInteger(chat) && chat > 0) { where.push('m.conversation_id = ?'); params.push(chat); applied.chat = chat; }
  if (typeof q.from === 'string' && DAY.test(q.from)) { where.push('m.created_at >= ?'); params.push(q.from + ' 00:00:00'); applied.from = q.from; }
  if (typeof q.to === 'string' && DAY.test(q.to)) { where.push('m.created_at <= ?'); params.push(q.to + ' 23:59:59'); applied.to = q.to; }
  const words = typeof q.words === 'string' ? q.words.trim().slice(0, 200) : '';
  if (words) { where.push("m.body ILIKE ? ESCAPE '\\'"); params.push('%' + escapeLike(words) + '%'); applied.words = words; }
  if (Object.keys(applied).length === 0) return { error: 'Choose at least one filter: a person, a place, dates or words.' };
  return { sql: 'WHERE ' + where.join(' AND '), params, applied };
}

// The ids ticked on the page (one or many), as numbers; at most 100 at a time.
function recallIds(raw) {
  const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  return [...new Set(list)].slice(0, 100);
}

module.exports = { recallFilters, recallIds, escapeLike };
