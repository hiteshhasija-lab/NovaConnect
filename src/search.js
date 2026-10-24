const { MeiliSearch } = require('meilisearch');
const { db } = require('./db');
const { INDEX_SETTINGS, buildFilter, sqlConditions, hasLink } = require('./searchFilter');
const { parseSearchQuery } = require('./searchQuery');

const MEILI_HOST = process.env.MEILI_HOST || 'http://localhost:7700';
const MEILI_API_KEY = process.env.MEILI_API_KEY || '';
const INDEX_NAME = 'messages';

let client = null;
let index = null;

async function getClient() {
  if (!client) {
    client = new MeiliSearch({ host: MEILI_HOST, apiKey: MEILI_API_KEY });
  }
  return client;
}

async function getIndex() {
  if (!index) {
    const c = await getClient();
    index = c.index(INDEX_NAME);
  }
  return index;
}

async function ensureIndex() {
  const c = await getClient();
  const indexes = await c.getIndexes();
  const indexList = indexes.results || indexes;
  const exists = indexList.some(i => i.uid === INDEX_NAME);
  if (!exists) {
    const created = await c.createIndex(INDEX_NAME, { primaryKey: 'id' });
    if (created && created.taskUid !== undefined) await c.waitForTask(created.taskUid, { timeOutMs: 60000 });
  }
  const idx = await getIndex();
  // Settings are applied by a background task; wait for it so a search made right after start-up
  // never meets the old settings.
  const task = await idx.updateSettings(INDEX_SETTINGS);
  if (task && task.taskUid !== undefined) await c.waitForTask(task.taskUid, { timeOutMs: 60000 });
}

// A search that touches every attribute the real queries use, so a settings mistake is reported at
// start-up instead of on the first user search. Resolves to null when fine, else the error message.
async function selfCheck() {
  try {
    const idx = await getIndex();
    await idx.search('', { filter: buildFilter([0], [0]), limit: 0 });
    return null;
  } catch (e) {
    return e.message;
  }
}

// The fields every indexed message carries for the search bar's filters (see searchFilter.js).
function filterFields(createdAt, body, hasFile) {
  // The first 19 characters ('YYYY-MM-DD HH:MM:SS', UTC): a few old rows carry fractions and '+00'
  // ('2026-09-23 15:42:19.70825+00'), which Date.parse rejects with the 'Z' added.
  const ms = Date.parse(String(createdAt || '').slice(0, 19).replace(' ', 'T') + 'Z');
  return { created_ts: Number.isFinite(ms) ? Math.floor(ms / 1000) : 0, has_file: !!hasFile, has_link: hasLink(body) };
}

async function indexMessage(message, author, channel, conversation, team) {
  const idx = await getIndex();
  const attached = await db.prepare('SELECT 1 AS x FROM attachments WHERE message_id = ? LIMIT 1').get(message.id);
  const doc = {
    ...filterFields(message.created_at, message.body, !!attached),
    id: message.id,
    body: message.body || '',
    author_id: message.user_id,
    author_name: author?.full_name || '',
    channel_id: message.channel_id || null,
    channel_name: channel?.name || null,
    conversation_id: message.conversation_id || null,
    conversation_name: conversation?.name || null,
    team_id: team?.id || null,
    is_thread: !!message.parent_message_id,
    parent_message_id: message.parent_message_id || null,
    created_at: message.created_at,
    updated_at: message.updated_at,
    deleted: !!message.deleted,
  };
  await idx.addDocuments([doc]);
}

async function removeMessage(messageId) {
  const idx = await getIndex();
  await idx.deleteDocument(messageId);
}

async function updateMessage(message, author, channel, conversation, team) {
  await indexMessage(message, author, channel, conversation, team);
}

async function reindexAll() {
  await ensureIndex();
  const idx = await getIndex();

  // Upsert every live message in batches (documents are replaced by id), so search keeps answering
  // while this runs; then remove documents that no longer exist in the database.
  const batchSize = 500;
  let lastId = 0;
  let lastTask = null;     // Meilisearch queues work; the last task is waited for so "done" is true
  const live = new Set();
  while (true) {
    const rows = await db.prepare(`
      SELECT m.*, u.full_name as author_name,
        c.name as channel_name, c.team_id,
        dc.name as conversation_name, dc.is_group,
        EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) AS has_file
      FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
      WHERE m.deleted = 0 AND m.id > ?
      ORDER BY m.id
      LIMIT ?
    `).all(lastId, batchSize);
    if (!rows.length) break;

    const docs = rows.map(r => ({
      ...filterFields(r.created_at, r.body, r.has_file),
      id: r.id,
      body: r.body || '',
      author_id: r.user_id,
      author_name: r.author_name || '',
      channel_id: r.channel_id || null,
      channel_name: r.channel_name || null,
      conversation_id: r.conversation_id || null,
      conversation_name: r.conversation_name || null,
      team_id: r.team_id || null,
      is_thread: !!r.parent_message_id,
      parent_message_id: r.parent_message_id || null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      deleted: false,
    }));
    lastTask = await idx.addDocuments(docs);
    for (const r of rows) live.add(Number(r.id));
    lastId = Number(rows[rows.length - 1].id);
  }

  const stale = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await idx.getDocuments({ fields: ['id'], limit: pageSize, offset });
    const results = page.results || page;
    if (!results.length) break;
    for (const doc of results) if (!live.has(Number(doc.id))) stale.push(doc.id);
    if (results.length < pageSize) break;
  }
  for (let i = 0; i < stale.length; i += 1000) lastTask = await idx.deleteDocuments(stale.slice(i, i + 1000));
  if (lastTask && lastTask.taskUid !== undefined) {
    const c = await getClient();
    await c.waitForTask(lastTask.taskUid, { timeOutMs: 120000 });
  }
  return { indexed: live.size, removed: stale.length };
}

async function searchMessages(userId, query, options = {}) {
  const idx = await getIndex();

  const accessibleChannels = await db.prepare(`
    SELECT c.id FROM channels c
    JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = ?
    WHERE c.is_private = 0
    UNION
    SELECT cm.channel_id FROM channel_members cm WHERE cm.user_id = ?
  `).all(userId, userId);
  const channelIds = accessibleChannels.map(r => r.id);

  const accessibleConvos = await db.prepare(`
    SELECT conversation_id FROM dm_participants WHERE user_id = ?
  `).all(userId);
  const convoIds = accessibleConvos.map(r => r.conversation_id);

  // A user with no accessible channels or conversations must see nothing, not everything.
  const filter = buildFilter(channelIds, convoIds);
  if (!filter) return { hits: [], estimatedTotalHits: 0, query, processingTimeMs: 0 };

  const limit = Math.min(options.limit || 50, 100);
  const offset = options.offset || 0;
  const sort = options.sort || ['created_at:desc'];

  const result = await idx.search(query, {
    filter,
    limit,
    offset,
    sort,
    attributesToHighlight: ['body', 'author_name'],
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
    showMatchesPosition: true,
  });

  return {
    hits: result.hits,
    estimatedTotalHits: result.estimatedTotalHits,
    query: result.query,
    processingTimeMs: result.processingTimeMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Global search for the UI (GET /api/search): { messages, files, people, source }.
//
// The client (public/js/workspace.js) renders messages with author, chat and date, files, and
// people. Meilisearch is used only to rank and select message ids (typo tolerance, relevance); the
// rows themselves are read back from Postgres, so what is shown is always current, the access rules
// are applied a second time, and there is one result shape whichever engine answered. If
// Meilisearch is down, slow or erroring, messages come from a plain Postgres search instead
// (source: 'postgres') and the user still gets results. Files and people are Postgres either way.
// ---------------------------------------------------------------------------------------------
const MEILI_TIMEOUT_MS = 3000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Meilisearch did not answer within ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function visibleScope(userId) {
  const channelIds = (await db.prepare(`
    SELECT c.id FROM channels c
    JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = ?
    WHERE c.is_private = 0
    UNION
    SELECT cm.channel_id AS id FROM channel_members cm WHERE cm.user_id = ?
  `).all(userId, userId)).map(r => r.id);
  const convoIds = (await db.prepare('SELECT conversation_id AS id FROM dm_participants WHERE user_id = ?').all(userId)).map(r => r.id);
  return { channelIds, convoIds };
}

const placeholders = (n) => Array(n).fill('?').join(',');

// Rows for the given message ids, in the given order, limited to what the user may see.
async function hydrateMessages(ids, scope) {
  if (!ids.length || (!scope.channelIds.length && !scope.convoIds.length)) return [];
  const access = [];
  const params = [...ids];
  if (scope.channelIds.length) { access.push(`m.channel_id IN (${placeholders(scope.channelIds.length)})`); params.push(...scope.channelIds); }
  if (scope.convoIds.length) { access.push(`m.conversation_id IN (${placeholders(scope.convoIds.length)})`); params.push(...scope.convoIds); }
  const rows = await db.prepare(`
    SELECT m.id, m.body, m.created_at, m.channel_id, m.conversation_id, u.full_name AS author_name,
           c.name AS channel_name, dc.is_group AS dm_is_group
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    LEFT JOIN channels c ON c.id = m.channel_id
    LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
    WHERE m.deleted = 0 AND m.id IN (${placeholders(ids.length)}) AND (${access.join(' OR ')})
  `).all(...params);
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  return ids.map(id => byId.get(Number(id))).filter(Boolean);
}

async function messagesFromMeilisearch(q, scope, limit, extra = {}) {
  const filter = buildFilter(scope.channelIds, scope.convoIds, {
    authorIds: extra.authorIds, afterTs: extra.afterTs, beforeTs: extra.beforeTs, hasFile: extra.hasFile, hasLink: extra.hasLink,
  });
  if (!filter) return [];
  const idx = await getIndex();
  // Filters with no words (e.g. "from:me has:file"): newest first instead of relevance.
  const options = { filter, limit, attributesToRetrieve: ['id'] };
  if (!q) options.sort = ['created_at:desc'];
  const result = await withTimeout(idx.search(q, options), MEILI_TIMEOUT_MS);
  return hydrateMessages(result.hits.map(h => h.id), scope);
}

// The search used before Meilisearch: newest first, case-insensitive substring of the body.
async function messagesFromPostgres(q, scope, limit, extra = {}) {
  const parts = [];
  const params = [];
  const cond = sqlConditions(extra);
  const more = cond.sql.map((c) => ` AND ${c}`).join('');
  if (scope.channelIds.length) {
    parts.push(`SELECT m.id, m.body, m.created_at, m.channel_id, m.conversation_id, u.full_name AS author_name, c.name AS channel_name, NULL AS dm_is_group
          FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN channels c ON c.id = m.channel_id
          WHERE m.deleted = 0 AND m.channel_id IN (${placeholders(scope.channelIds.length)}) AND strpos(lower(m.body), lower(?)) > 0${more}`);
    params.push(...scope.channelIds, q, ...cond.params);
  }
  if (scope.convoIds.length) {
    parts.push(`SELECT m.id, m.body, m.created_at, m.channel_id, m.conversation_id, u.full_name AS author_name, NULL AS channel_name, dc.is_group AS dm_is_group
          FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
          WHERE m.deleted = 0 AND m.conversation_id IN (${placeholders(scope.convoIds.length)}) AND strpos(lower(m.body), lower(?)) > 0${more}`);
    params.push(...scope.convoIds, q, ...cond.params);
  }
  if (!parts.length) return [];
  return db.prepare(`${parts.join(' UNION ALL ')} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 25, 100))}`).all(...params);
}

async function filesFromPostgres(q, scope, limit, extra = {}) {
  const parts = [];
  const params = [];
  const cond = sqlConditions(extra, { forFiles: true });
  const more = cond.sql.map((c) => ` AND ${c}`).join('');
  if (scope.channelIds.length) {
    parts.push(`SELECT a.id, a.original_name, a.mime_type, a.created_at, m.channel_id, m.conversation_id, c.name AS channel_name, NULL AS dm_is_group
          FROM attachments a JOIN messages m ON m.id = a.message_id LEFT JOIN channels c ON c.id = m.channel_id
          WHERE m.deleted = 0 AND m.channel_id IN (${placeholders(scope.channelIds.length)}) AND strpos(lower(a.original_name), lower(?)) > 0${more}`);
    params.push(...scope.channelIds, q, ...cond.params);
  }
  if (scope.convoIds.length) {
    parts.push(`SELECT a.id, a.original_name, a.mime_type, a.created_at, m.channel_id, m.conversation_id, NULL AS channel_name, dc.is_group AS dm_is_group
          FROM attachments a JOIN messages m ON m.id = a.message_id LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
          WHERE m.deleted = 0 AND m.conversation_id IN (${placeholders(scope.convoIds.length)}) AND strpos(lower(a.original_name), lower(?)) > 0${more}`);
    params.push(...scope.convoIds, q, ...cond.params);
  }
  if (!parts.length) return [];
  return db.prepare(`${parts.join(' UNION ALL ')} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 25, 100))}`).all(...params);
}

async function peopleFromPostgres(userId, q) {
  const like = `%${q}%`;
  return db.prepare(`
    SELECT id, full_name, username, email, title, status FROM users
    WHERE active = 1 AND id != ? AND (full_name ILIKE ? OR username ILIKE ? OR email ILIKE ?)
      AND id NOT IN (SELECT blocked_id FROM blocked_users WHERE blocker_id = ?)
      AND id NOT IN (SELECT blocker_id FROM blocked_users WHERE blocked_id = ?)
    ORDER BY full_name LIMIT 10
  `).all(userId, like, like, like, userId, userId);
}

// from:<values> -> user ids. "me" is the searcher; otherwise an exact username or full name, or a
// first name ("from:jane" finds "Jane Doe"), case-insensitive; a leading @ is ignored.
async function resolvePeople(userId, values) {
  const found = new Set();
  const unmatched = [];
  for (const raw of values) {
    const v = raw.replace(/^@/, '').trim();
    if (v.toLowerCase() === 'me') { found.add(Number(userId)); continue; }
    const rows = await db.prepare(`
      SELECT id FROM users
      WHERE lower(username) = lower(?) OR lower(full_name) = lower(?) OR lower(full_name) LIKE lower(?) || ' %'
    `).all(v, v, v);
    if (rows.length) rows.forEach((r) => found.add(Number(r.id))); else unmatched.push(raw);
  }
  return { ids: [...found], unmatched };
}

// in:<values> -> the channels and chats they name, ONLY among those the searcher may see.
// "#name" means a channel, "@name" a chat (with that person, or a group chat called that), and a bare
// name either one.
async function resolvePlaces(userId, values, scope) {
  const channelIds = new Set();
  const convoIds = new Set();
  const unmatched = [];
  for (const raw of values) {
    const kind = raw.startsWith('#') ? 'channel' : raw.startsWith('@') ? 'chat' : 'any';
    const v = raw.replace(/^[#@]/, '').trim();
    let hit = false;
    if (kind !== 'chat' && scope.channelIds.length) {
      const rows = await db.prepare(`SELECT id FROM channels WHERE id IN (${placeholders(scope.channelIds.length)}) AND lower(name) = lower(?)`).all(...scope.channelIds, v);
      rows.forEach((r) => channelIds.add(Number(r.id))); hit = hit || rows.length > 0;
    }
    if (kind !== 'channel' && scope.convoIds.length) {
      const rows = await db.prepare(`
        SELECT DISTINCT dc.id FROM dm_conversations dc
        JOIN dm_participants p ON p.conversation_id = dc.id
        JOIN users u ON u.id = p.user_id
        WHERE dc.id IN (${placeholders(scope.convoIds.length)})
          AND (lower(coalesce(dc.name, '')) = lower(?)
               OR (u.id <> ? AND (lower(u.username) = lower(?) OR lower(u.full_name) = lower(?) OR lower(u.full_name) LIKE lower(?) || ' %')))
      `).all(...scope.convoIds, v, userId, v, v, v);
      rows.forEach((r) => convoIds.add(Number(r.id))); hit = hit || rows.length > 0;
    }
    if (!hit) unmatched.push(raw);
  }
  return { channelIds: [...channelIds], convoIds: [...convoIds], unmatched };
}

// GET /api/search. Answers { messages, files, people, source, filters, terms, notes }:
//   filters  the filters understood, as { type, value, label } (shown as chips)
//   terms    the free-text words, for highlighting
//   notes    plain-language reasons a filter matched nothing ("No one matches from:bob")
// options.tz: the browser's Date.getTimezoneOffset(), so dates mean the searcher's own days.
async function globalSearch(userId, rawQuery, options = {}) {
  const raw = String(rawQuery || '').trim().slice(0, 200);
  const tz = Number.parseInt(options.tz, 10);
  const parsed = parseSearchQuery(raw, { tzOffsetMinutes: Number.isInteger(tz) ? tz : 0 });
  const empty = { messages: [], files: [], people: [], source: 'none', filters: parsed.applied, terms: parsed.terms, notes: [] };
  if (!parsed.text && !parsed.hasFilters) return empty;
  const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
  let scope = await visibleScope(userId);
  const notes = [];
  const extra = {
    hasFile: parsed.has.file, hasLink: parsed.has.link,
    afterTs: parsed.after ? parsed.after.ts : undefined, beforeTs: parsed.before ? parsed.before.ts : undefined,
    afterSql: parsed.after ? parsed.after.sql : undefined, beforeSql: parsed.before ? parsed.before.sql : undefined,
  };
  if (parsed.from.length) {
    const people = await resolvePeople(userId, parsed.from);
    people.unmatched.forEach((v) => notes.push(`No one matches from:${v}`));
    extra.authorIds = people.ids;   // [] -> nothing can match
  }
  if (parsed.in.length) {
    const places = await resolvePlaces(userId, parsed.in, scope);
    places.unmatched.forEach((v) => notes.push(`No channel or chat you can see matches in:${v}`));
    scope = { channelIds: places.channelIds, convoIds: places.convoIds };
  }

  let messages;
  let source = 'meilisearch';
  try {
    messages = await messagesFromMeilisearch(parsed.text, scope, limit, extra);
  } catch (e) {
    console.error('Meilisearch search failed, using the database instead:', e.message);
    source = 'postgres';
    messages = await messagesFromPostgres(parsed.text, scope, limit, extra);
  }
  // Files: by name, narrowed by from:/in:/dates. has:link is about messages, so no files then.
  const files = parsed.has.link ? [] : await filesFromPostgres(parsed.text, scope, limit, extra);
  // People: only for a plain search; filters are about messages and files.
  const people = parsed.text && !parsed.hasFilters ? await peopleFromPostgres(userId, parsed.text) : [];
  return { messages, files, people, source, filters: parsed.applied, terms: parsed.terms, notes };
}

module.exports = {
  globalSearch,
  visibleScope,
  INDEX_SETTINGS,
  buildFilter,
  selfCheck,
  ensureIndex,
  indexMessage,
  removeMessage,
  updateMessage,
  reindexAll,
  searchMessages,
};