// Search settings and the access filter, kept free of database and Meilisearch imports so they can
// be unit-tested on their own (test/search.test.js).

// Every attribute used in a filter must be listed in filterableAttributes, or Meilisearch rejects the
// whole query (invalid_search_filter). `deleted` was missing from this list, so every search failed;
// test/search.test.js keeps the filter and this list in step.
const INDEX_SETTINGS = {
  searchableAttributes: ['body', 'author_name', 'channel_name', 'conversation_name'],
  // created_ts (epoch seconds), has_file and has_link serve the search bar's filters (src/searchQuery.js):
  // Meilisearch compares numbers only, so the date filters need the numeric copy of created_at.
  filterableAttributes: ['channel_id', 'conversation_id', 'author_id', 'team_id', 'is_thread', 'created_at', 'deleted', 'created_ts', 'has_file', 'has_link'],
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

const ids = (list) => (list || []).map(Number).filter(Number.isInteger);

// The access filter: only the given channels and conversations, and never a deleted message.
// `NOT deleted = true` (rather than `deleted = false`) also matches documents written before the
// field was boolean. Returns null when there is nothing the user may see.
// `extra` narrows it further for the search bar's filters (all optional, all ANDed):
//   authorIds [numbers], afterTs / beforeTs (epoch seconds; after inclusive, before exclusive),
//   hasFile, hasLink (booleans). Every value is forced to a number or a fixed literal, so nothing a
//   user types can reach the filter expression.
function buildFilter(channelIds, convoIds, extra = {}) {
  const channels = ids(channelIds);
  const convos = ids(convoIds);
  const orParts = [];
  if (channels.length) orParts.push(`channel_id IN [${channels.join(',')}]`);
  if (convos.length) orParts.push(`conversation_id IN [${convos.join(',')}]`);
  if (!orParts.length) return null;
  const parts = [`(${orParts.join(' OR ')})`, 'NOT deleted = true'];
  if (extra.authorIds) {
    const authors = ids(extra.authorIds);
    if (!authors.length) return null;   // a from: that matched nobody can match no message
    parts.push(`author_id IN [${authors.join(',')}]`);
  }
  if (Number.isFinite(extra.afterTs)) parts.push(`created_ts >= ${Math.floor(extra.afterTs)}`);
  if (Number.isFinite(extra.beforeTs)) parts.push(`created_ts < ${Math.floor(extra.beforeTs)}`);
  if (extra.hasFile) parts.push('has_file = true');
  if (extra.hasLink) parts.push('has_link = true');
  return parts.join(' AND ');
}

// The same filters for the Postgres paths (messages when Meilisearch is unavailable, and files).
// Returns SQL fragments to AND onto a query plus their parameters. `m` is the messages alias; with
// `forFiles` the author and dates apply to the attachment (`a`) and has:file/has:link are left out
// (every file has a file; links are a message property).
function sqlConditions(extra = {}, { forFiles = false } = {}) {
  const sql = [];
  const params = [];
  if (extra.authorIds) {
    const authors = ids(extra.authorIds);
    if (!authors.length) return { sql: ['FALSE'], params: [] };
    sql.push(`${forFiles ? 'a.uploaded_by' : 'm.user_id'} IN (${authors.map(() => '?').join(',')})`);
    params.push(...authors);
  }
  const at = forFiles ? 'a.created_at' : 'm.created_at';
  if (typeof extra.afterSql === 'string') { sql.push(`${at} >= ?`); params.push(extra.afterSql); }
  if (typeof extra.beforeSql === 'string') { sql.push(`${at} < ?`); params.push(extra.beforeSql); }
  if (!forFiles && extra.hasFile) sql.push('EXISTS (SELECT 1 FROM attachments fa WHERE fa.message_id = m.id)');
  // No '?' in here: knex reads every '?' in the SQL as a parameter, even inside a quoted regex.
  if (!forFiles && extra.hasLink) sql.push(`(m.body ILIKE '%http://%' OR m.body ILIKE '%https://%')`);
  return { sql, params };
}

// Does this message body contain a web link? (has:link, kept in step with sqlConditions' regex.)
const hasLink = (body) => /https?:\/\//i.test(String(body || ''));

module.exports = { INDEX_SETTINGS, buildFilter, sqlConditions, hasLink };
