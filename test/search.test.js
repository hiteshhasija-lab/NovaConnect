const test = require('node:test');
const assert = require('node:assert/strict');
const { INDEX_SETTINGS, buildFilter } = require('../src/searchFilter');

// Attribute names that appear in a Meilisearch filter expression.
function attributesIn(filter) {
  return [...new Set([...filter.matchAll(/\b([a-z_]+)\s*(?:=|!=|IN\b)/g)].map((m) => m[1]))];
}

test('every attribute the search filter uses is filterable (a missing one made every search fail)', () => {
  const filter = buildFilter([1, 2], [3]);
  const used = attributesIn(filter);
  assert.ok(used.includes('deleted'), 'the filter excludes deleted messages');
  for (const a of used) assert.ok(INDEX_SETTINGS.filterableAttributes.includes(a), `${a} is not filterable`);
});

test('the filter limits results to the given channels and conversations and hides deleted messages', () => {
  assert.equal(buildFilter([1, 2], [3]), '(channel_id IN [1,2] OR conversation_id IN [3]) AND NOT deleted = true');
  assert.equal(buildFilter([7], []), '(channel_id IN [7]) AND NOT deleted = true');
  assert.equal(buildFilter([], [4]), '(conversation_id IN [4]) AND NOT deleted = true');
});

test('a user who can see nothing gets no filter, so the caller returns nothing instead of everything', () => {
  assert.equal(buildFilter([], []), null);
  assert.equal(buildFilter(undefined, undefined), null);
});

test('ids are forced to numbers and anything else is dropped, so nothing can inject filter syntax', () => {
  assert.equal(buildFilter(['1', '2'], []), '(channel_id IN [1,2]) AND NOT deleted = true');
  assert.equal(buildFilter(['1 OR author_id = 9'], []), null);
  assert.equal(buildFilter([5, 'x'], [6]), '(channel_id IN [5] OR conversation_id IN [6]) AND NOT deleted = true');
});

test('sorting and search attributes used by the route are declared', () => {
  assert.ok(INDEX_SETTINGS.sortableAttributes.includes('created_at'));
  assert.ok(INDEX_SETTINGS.searchableAttributes.includes('body'));
});

// ---- Search-bar filters (Phase 3) ---------------------------------------------------------------
const { sqlConditions, hasLink } = require('../src/searchFilter');

test('every attribute the filters use is filterable, including the new date/file/link fields', () => {
  const filter = buildFilter([1], [2], { authorIds: [3], afterTs: 10, beforeTs: 20, hasFile: true, hasLink: true });
  const used = [...new Set([...filter.matchAll(/\b([a-z_]+)\s*(?:=|!=|>=|<|IN\b)/g)].map((m) => m[1]))];
  for (const a of ['author_id', 'created_ts', 'has_file', 'has_link']) assert.ok(used.includes(a), `${a} not used`);
  for (const a of used) assert.ok(INDEX_SETTINGS.filterableAttributes.includes(a), `${a} is not filterable`);
});

test('filters narrow the access filter and never widen it', () => {
  assert.equal(
    buildFilter([1], [], { authorIds: ['4'], afterTs: 100.9, beforeTs: 200, hasFile: true }),
    '(channel_id IN [1]) AND NOT deleted = true AND author_id IN [4] AND created_ts >= 100 AND created_ts < 200 AND has_file = true',
  );
  assert.equal(buildFilter([], [], { authorIds: [4] }), null, 'no access stays no results');
});

test('a from: that matched nobody matches no message (not every message)', () => {
  assert.equal(buildFilter([1], [2], { authorIds: [] }), null);
  assert.deepEqual(sqlConditions({ authorIds: [] }), { sql: ['FALSE'], params: [] });
});

test('nothing typed reaches the filter expression: authors are numbers, dates are numbers', () => {
  const f = buildFilter([1], [], { authorIds: ['1 OR 1=1', 5], afterTs: 'x', beforeTs: NaN });
  assert.equal(f, '(channel_id IN [1]) AND NOT deleted = true AND author_id IN [5]');
});

test('the Postgres conditions match the Meilisearch ones and use placeholders', () => {
  assert.deepEqual(sqlConditions({ authorIds: [7, 8], afterSql: '2026-10-01 05:00:00', beforeSql: '2026-10-02 05:00:00', hasFile: true, hasLink: true }), {
    sql: ['m.user_id IN (?,?)', 'm.created_at >= ?', 'm.created_at < ?', 'EXISTS (SELECT 1 FROM attachments fa WHERE fa.message_id = m.id)', "(m.body ILIKE '%http://%' OR m.body ILIKE '%https://%')"],
    params: [7, 8, '2026-10-01 05:00:00', '2026-10-02 05:00:00'],
  });
  assert.deepEqual(sqlConditions({ authorIds: [7], afterSql: 'a', hasFile: true, hasLink: true }, { forFiles: true }), {
    sql: ['a.uploaded_by IN (?)', 'a.created_at >= ?'], params: [7, 'a'],
  });
});

test('no SQL condition contains a "?" outside the placeholders (knex would take it for one)', () => {
  const { sql, params } = sqlConditions({ authorIds: [1], afterSql: 'a', beforeSql: 'b', hasFile: true, hasLink: true });
  assert.equal(sql.join(' ').split('?').length - 1, params.length);
});

test('has:link means a web link, same rule as the database condition', () => {
  assert.equal(hasLink('see https://example.com'), true);
  assert.equal(hasLink('HTTP://x.y'), true);
  assert.equal(hasLink('no link here, just http talk'), false);
  assert.equal(hasLink(null), false);
});
