// Search settings and the access filter, kept free of database and Meilisearch imports so they can
// be unit-tested on their own (test/search.test.js).

// Every attribute used in a filter must be listed in filterableAttributes, or Meilisearch rejects the
// whole query (invalid_search_filter). `deleted` was missing from this list, so every search failed;
// test/search.test.js keeps the filter and this list in step.
const INDEX_SETTINGS = {
  searchableAttributes: ['body', 'author_name', 'channel_name', 'conversation_name'],
  filterableAttributes: ['channel_id', 'conversation_id', 'author_id', 'team_id', 'is_thread', 'created_at', 'deleted'],
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
};

// The access filter: only the given channels and conversations, and never a deleted message.
// `NOT deleted = true` (rather than `deleted = false`) also matches documents written before the
// field was boolean. Returns null when there is nothing the user may see.
function buildFilter(channelIds, convoIds) {
  const ids = (list) => (list || []).map(Number).filter(Number.isInteger);
  const channels = ids(channelIds);
  const convos = ids(convoIds);
  const orParts = [];
  if (channels.length) orParts.push(`channel_id IN [${channels.join(',')}]`);
  if (convos.length) orParts.push(`conversation_id IN [${convos.join(',')}]`);
  if (!orParts.length) return null;
  return `(${orParts.join(' OR ')}) AND NOT deleted = true`;
}

module.exports = { INDEX_SETTINGS, buildFilter };
