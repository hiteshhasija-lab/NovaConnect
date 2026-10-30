// eDiscovery (Admin and compliance): an admin's case with one search over every message the app
// holds, previewed and exported for a review (/admin/ediscovery, routes/admin.js). Admins only;
// every case change, search, export and file download is in the audit log.
//
// Where to look (any of these; everywhere when none):
//   people   — what they wrote, anywhere, and every message in a chat they are in
//   channels — every message in them, replies included
//   chats    — every message in them
// Conditions (all must hold): written on or after / on or before a day (UTC), and every word or
// "quoted phrase" appearing (case-insensitive) in the text, an announcement's banner, or any earlier
// version of the message (edit history), so editing a word away doesn't hide a message.
// What is found: live messages, and the copies legal hold kept of messages deleted or recalled
// (src/legalHold.js), each with its earlier versions and its files.
const { db } = require('./db');
const { csvCell } = require('./audit');

const MAX_IDS = 50;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const ids = (raw) => [...new Set((Array.isArray(raw) ? raw : raw === undefined || raw === '' ? [] : String(raw).split(','))
  .map(Number).filter(n => Number.isSafeInteger(n) && n > 0))].slice(0, MAX_IDS);
const truthy = (v) => v === true || v === 'on' || v === '1' || v === 'true';

// Words and "quoted phrases", at most 10.
function terms(words) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(words || ''))) && out.length < 10) {
    const t = (m[1] || m[2]).trim();
    if (t) out.push(t);
  }
  return out;
}

// The case form (or saved JSON) as criteria. Unknown ids are dropped, not errors.
function parseCriteria(b = {}) {
  const words = typeof b.words === 'string' ? b.words.trim().slice(0, 300) : '';
  const c = {
    people: ids(b.people), channels: ids(b.channels), chats: ids(b.chats),
    from: typeof b.from === 'string' && DAY.test(b.from) ? b.from : '',
    to: typeof b.to === 'string' && DAY.test(b.to) ? b.to : '',
    words,
    include_preserved: b.include_preserved === undefined ? true : truthy(b.include_preserved),
    include_versions: b.include_versions === undefined ? true : truthy(b.include_versions),
  };
  if (c.from && c.to && c.to < c.from) return { error: 'The "to" day is before the "from" day.' };
  return { value: c };
}

const list = (n) => Array.from({ length: n }, () => '?').join(',');

// WHERE for live messages (alias m) or legal-hold copies (alias p). No '?' outside bindings.
function whereFor(c, kind) {
  const live = kind === 'live';
  const col = live
    ? { author: 'm.user_id', channel: 'm.channel_id', chat: 'm.conversation_id', created: 'm.created_at', id: 'm.id' }
    : { author: 'p.author_id', channel: 'p.channel_id', chat: 'p.conversation_id', created: 'p.message_created_at', id: 'p.message_id' };
  const where = [], params = [];
  if (live) where.push('m.deleted = 0');
  const sources = [];
  if (c.people.length) {
    sources.push(`(${col.author} IN (${list(c.people.length)}) OR EXISTS (SELECT 1 FROM dm_participants ep WHERE ep.conversation_id = ${col.chat} AND ep.user_id IN (${list(c.people.length)})))`);
    params.push(...c.people, ...c.people);
  }
  if (c.channels.length) { sources.push(`${col.channel} IN (${list(c.channels.length)})`); params.push(...c.channels); }
  if (c.chats.length) { sources.push(`${col.chat} IN (${list(c.chats.length)})`); params.push(...c.chats); }
  if (sources.length) where.push('(' + sources.join(' OR ') + ')');
  if (c.from) { where.push(`${col.created} >= ?`); params.push(c.from + ' 00:00:00'); }
  if (c.to) { where.push(`${col.created} <= ?`); params.push(c.to + ' 23:59:59'); }
  for (const t of terms(c.words)) {
    const like = '%' + escapeLike(t) + '%';
    if (live) {
      where.push(`(m.body ILIKE ? ESCAPE '\\' OR (COALESCE(m.metadata, '') LIKE '%"announcement"%' AND m.metadata ILIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM message_edits ee WHERE ee.message_id = m.id AND ee.body ILIKE ? ESCAPE '\\'))`);
    } else {
      where.push(`(p.body ILIKE ? ESCAPE '\\' OR (COALESCE(p.metadata, '') LIKE '%"announcement"%' AND p.metadata ILIKE ? ESCAPE '\\') OR COALESCE(p.edits, '') ILIKE ? ESCAPE '\\')`);
    }
    params.push(like, like, like);
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params, idCol: col.id };
}

const placeOf = (r) => (r.channel_id ? `${r.team_name || 'Team'} › #${r.channel_name || r.channel_id}` : r.conversation_id ? `Chat #${r.conversation_id}` : '');
const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

// Runs the search: { live, preserved, total, items } with up to `limit` items, newest first.
// onlyMessageId narrows it to one message (is this message in the case?).
async function runSearch(c, { limit = 100, onlyMessageId = null } = {}) {
  const liveW = whereFor(c, 'live');
  if (onlyMessageId) { liveW.sql += (liveW.sql ? ' AND ' : 'WHERE ') + 'm.id = ?'; liveW.params.push(onlyMessageId); }
  const liveCount = Number((await db.prepare(`SELECT COUNT(*) AS n FROM messages m ${liveW.sql}`).get(...liveW.params)).n);
  const liveRows = await db.prepare(`
    SELECT m.id AS message_id, m.created_at AS written_at, m.body, m.metadata, m.edited, m.parent_message_id, m.channel_id, m.conversation_id,
      u.full_name AS author, u.username AS author_username, c.name AS channel_name, t.name AS team_name
    FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN channels c ON c.id = m.channel_id LEFT JOIN teams t ON t.id = c.team_id
    ${liveW.sql} ORDER BY m.created_at DESC, m.id DESC LIMIT ${Number(limit)}
  `).all(...liveW.params);

  let preservedCount = 0, preservedRows = [];
  if (c.include_preserved) {
    const pw = whereFor(c, 'preserved');
    if (onlyMessageId) { pw.sql += (pw.sql ? ' AND ' : 'WHERE ') + 'p.message_id = ?'; pw.params.push(onlyMessageId); }
    preservedCount = Number((await db.prepare(`SELECT COUNT(*) AS n FROM preserved_messages p ${pw.sql}`).get(...pw.params)).n);
    preservedRows = await db.prepare(`
      SELECT p.message_id, p.message_created_at AS written_at, p.body, p.metadata, p.edits, p.attachments, p.channel_id, p.conversation_id, p.reason, p.preserved_at,
        p.author_name AS author, u.username AS author_username, c.name AS channel_name, t.name AS team_name
      FROM preserved_messages p LEFT JOIN users u ON u.id = p.author_id LEFT JOIN channels c ON c.id = p.channel_id LEFT JOIN teams t ON t.id = c.team_id
      ${pw.sql} ORDER BY p.message_created_at DESC, p.id DESC LIMIT ${Number(limit)}
    `).all(...pw.params);
  }

  const liveIds = liveRows.map(r => r.message_id);
  const versions = {}, files = {};
  if (liveIds.length) {
    if (c.include_versions) {
      for (const e of await db.prepare(`SELECT message_id, body, replaced_at FROM message_edits WHERE message_id IN (${list(liveIds.length)}) ORDER BY id`).all(...liveIds)) {
        (versions[e.message_id] = versions[e.message_id] || []).push({ body: e.body, replaced_at: e.replaced_at });
      }
    }
    for (const a of await db.prepare(`SELECT id, message_id, original_name, mime_type, size FROM attachments WHERE message_id IN (${list(liveIds.length)}) ORDER BY id`).all(...liveIds)) {
      (files[a.message_id] = files[a.message_id] || []).push({ id: a.id, name: a.original_name, mime_type: a.mime_type, size: a.size });
    }
  }
  const banner = (meta) => parse(meta)?.announcement || null;
  const items = [
    ...liveRows.map(r => ({
      source: 'live', message_id: r.message_id, written_at: r.written_at, author: r.author, author_username: r.author_username, place: placeOf(r),
      reply_to: r.parent_message_id || null, announcement: banner(r.metadata), text: r.body, edited: !!r.edited,
      versions: c.include_versions ? (versions[r.message_id] || []) : [], files: files[r.message_id] || [],
    })),
    ...preservedRows.map(r => ({
      source: 'preserved', message_id: r.message_id, written_at: r.written_at, author: r.author, author_username: r.author_username, place: placeOf(r),
      reply_to: null, announcement: banner(r.metadata), text: r.body, edited: !!(parse(r.edits) || []).length,
      versions: c.include_versions ? (parse(r.edits) || []).map(e => ({ body: e.body, replaced_at: e.replaced_at })) : [],
      files: (parse(r.attachments) || []).map(f => ({ id: f.id, name: f.original_name, mime_type: f.mime_type, size: f.size })),
      preserved: { reason: r.reason, at: r.preserved_at },
    })),
  ].sort((a, b) => (a.written_at < b.written_at ? 1 : a.written_at > b.written_at ? -1 : b.message_id - a.message_id)).slice(0, limit);
  return { live: liveCount, preserved: preservedCount, total: liveCount + preservedCount, items };
}

// The export as CSV: one row per message (live or kept by a hold).
const CSV_COLUMNS = ['source', 'message_id', 'written_at_utc', 'author', 'author_username', 'place', 'reply_to', 'headline', 'text', 'edited', 'earlier_versions', 'files', 'preserved_reason', 'preserved_at_utc'];
function caseCsv(items) {
  const rows = items.map(i => [
    i.source, i.message_id, i.written_at, i.author, i.author_username, i.place, i.reply_to || '', i.announcement ? i.announcement.headline : '', i.text,
    i.edited ? 'yes' : 'no', i.versions.map(v => `[${v.replaced_at}] ${v.body}`).join('\n---\n'), i.files.map(f => `${f.name} (#${f.id})`).join('; '),
    i.preserved ? i.preserved.reason : '', i.preserved ? i.preserved.at : '',
  ].map(csvCell).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}

// A one-line description of the criteria, for the audit log and the export.
function describe(c) {
  const parts = [];
  if (c.people.length) parts.push(`people ${c.people.join(',')}`);
  if (c.channels.length) parts.push(`channels ${c.channels.join(',')}`);
  if (c.chats.length) parts.push(`chats ${c.chats.join(',')}`);
  if (!parts.length) parts.push('everywhere');
  if (c.from) parts.push(`from ${c.from}`);
  if (c.to) parts.push(`to ${c.to}`);
  if (c.words) parts.push(`words "${c.words}"`);
  return parts.join('; ');
}

module.exports = { parseCriteria, whereFor, runSearch, caseCsv, describe, terms, MAX_IDS };
