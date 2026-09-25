const { MeiliSearch } = require('meilisearch');
const { db } = require('./db');

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
  const exists = indexes.some(i => i.uid === INDEX_NAME);
  if (!exists) {
    await c.createIndex(INDEX_NAME, { primaryKey: 'id' });
  }
  const idx = await getIndex();
  await idx.updateSettings({
    searchableAttributes: ['body', 'author_name', 'channel_name', 'conversation_name'],
    filterableAttributes: ['channel_id', 'conversation_id', 'author_id', 'team_id', 'is_thread', 'created_at'],
    sortableAttributes: ['created_at'],
    rankingRules: [
      'words',
      'typo',
      'proximity',
      'attribute',
      'sort',
      'exactness',
      'created_at:desc'
    ],
    distinctAttribute: null,
  });
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
  await idx.deleteAllDocuments();

  const batchSize = 500;
  let offset = 0;
  while (true) {
    const rows = await db.prepare(`
      SELECT m.*, u.full_name as author_name,
        c.name as channel_name, c.team_id,
        dc.name as conversation_name, dc.is_group
      FROM messages m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN channels c ON c.id = m.channel_id
      LEFT JOIN dm_conversations dc ON dc.id = m.conversation_id
      WHERE m.deleted = 0
      ORDER BY m.id
      LIMIT ? OFFSET ?
    `).all(batchSize, offset);
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
      deleted: 0,
    }));
    await idx.addDocuments(docs);
    offset += batchSize;
  }
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

  const filterParts = [];
  if (channelIds.length || convoIds.length) {
    const orParts = [];
    if (channelIds.length) orParts.push(`channel_id IN [${channelIds.join(',')}]`);
    if (convoIds.length) orParts.push(`conversation_id IN [${convoIds.join(',')}]`);
    filterParts.push(`(${orParts.join(' OR ')})`);
  }
  filterParts.push('deleted = false');

  const filter = filterParts.join(' AND ');

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
  ensureIndex,
  indexMessage,
  removeMessage,
  updateMessage,
  reindexAll,
  searchMessages,
};