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

module.exports = {
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