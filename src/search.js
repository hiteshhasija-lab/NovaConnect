const { MeiliSearch } = require('meilisearch');
const { db } = require('./db');
const { INDEX_SETTINGS, buildFilter } = require('./searchFilter');

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

async function indexMessage(message, author, channel, conversation, team) {
  const idx = await getIndex();
  const doc = {
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
        dc.name as conversation_name, dc.is_group
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

async function messagesFromMeilisearch(q, scope, limit) {
  const filter = buildFilter(scope.channelIds, scope.convoIds);
  if (!filter) return [];
  const idx = await getIndex();
  const result = await withTimeout(idx.search(q, { filter, limit, attributesToRetrieve: ['id'] }), MEILI_TIMEOUT_MS);
  return hydrateMessages(result.hits.map(h => h.id), scope);
}

// The search used before Meilisearch: newest first, case-insensitive substring of the body.
async function messagesFromPostgres(q, scope, limit) {
  const parts = [];
  const params = [];
  if (scope.channelIds.length) {
    parts.push(`SELECT m.id, m.body, m.created_at, m.channel_id, m.conversation_id, u.full_name AS author_name, c.name AS channel_name, NULL AS dm_is_group
          FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN channels c ON c.id = m.channel_id
          WHERE m.deleted = 0 AND m.channel_id IN (${placeholders(scope.channelIds.length)}) AND strpos(lower(m.body), lower(?)) > 0`);
    params.push(...scope.channelIds, q);
  }
  if (scope.convoIds.length) {
    parts.push(`SELECT m.id, m.body, m.created_at, m.channel_id, m.conversation_id, u.full_name AS author_name, NULL AS channel_name, dc.is_group AS dm_is_group
          FROM messages m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
          WHERE m.deleted = 0 AND m.conversation_id IN (${placeholders(scope.convoIds.length)}) AND strpos(lower(m.body), lower(?)) > 0`);
    params.push(...scope.convoIds, q);
  }
  if (!parts.length) return [];
  return db.prepare(`${parts.join(' UNION ALL ')} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(Number(limit) || 25, 100))}`).all(...params);
}

async function filesFromPostgres(q, scope, limit) {
  const parts = [];
  const params = [];
  if (scope.channelIds.length) {
    parts.push(`SELECT a.id, a.original_name, a.mime_type, a.created_at, m.channel_id, m.conversation_id, c.name AS channel_name, NULL AS dm_is_group
          FROM attachments a JOIN messages m ON m.id = a.message_id LEFT JOIN channels c ON c.id = m.channel_id
          WHERE m.deleted = 0 AND m.channel_id IN (${placeholders(scope.channelIds.length)}) AND strpos(lower(a.original_name), lower(?)) > 0`);
    params.push(...scope.channelIds, q);
  }
  if (scope.convoIds.length) {
    parts.push(`SELECT a.id, a.original_name, a.mime_type, a.created_at, m.channel_id, m.conversation_id, NULL AS channel_name, dc.is_group AS dm_is_group
          FROM attachments a JOIN messages m ON m.id = a.message_id LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
          WHERE m.deleted = 0 AND m.conversation_id IN (${placeholders(scope.convoIds.length)}) AND strpos(lower(a.original_name), lower(?)) > 0`);
    params.push(...scope.convoIds, q);
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

async function globalSearch(userId, rawQuery, options = {}) {
  const q = String(rawQuery || '').trim().slice(0, 200);
  if (!q) return { messages: [], files: [], people: [], source: 'none' };
  const limit = Math.max(1, Math.min(Number(options.limit) || 25, 100));
  const scope = await visibleScope(userId);

  let messages;
  let source = 'meilisearch';
  try {
    messages = await messagesFromMeilisearch(q, scope, limit);
  } catch (e) {
    console.error('Meilisearch search failed, using the database instead:', e.message);
    source = 'postgres';
    messages = await messagesFromPostgres(q, scope, limit);
  }
  const [files, people] = await Promise.all([filesFromPostgres(q, scope, limit), peopleFromPostgres(userId, q)]);
  return { messages, files, people, source };
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