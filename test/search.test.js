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
