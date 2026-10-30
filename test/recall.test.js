const test = require('node:test');
const assert = require('node:assert/strict');
const { recallFilters, recallIds, escapeLike } = require('../src/recall');

test('at least one filter is required; deleted messages are never listed', () => {
  assert.match(recallFilters({}).error, /at least one/);
  assert.match(recallFilters({ person: 'x', from: '24/10/2026' }).error, /at least one/);
  const f = recallFilters({ person: '3' });
  assert.equal(f.sql, 'WHERE m.deleted = 0 AND m.user_id = ?');
  assert.deepEqual(f.params, [3]);
});

test('every filter is bound; words match literally (% and _ are not wildcards)', () => {
  const f = recallFilters({ person: '3', channel: '9', chat: '12', from: '2026-10-01', to: '2026-10-30', words: ' 100%_off ' });
  assert.equal((f.sql.match(/\?/g) || []).length, f.params.length);
  assert.deepEqual(f.params, [3, 9, 12, '2026-10-01 00:00:00', '2026-10-30 23:59:59', '%100\\%\\_off%']);
  assert.deepEqual(f.applied, { person: 3, channel: 9, chat: 12, from: '2026-10-01', to: '2026-10-30', words: '100%_off' });
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
});

test('ticked ids: one or many, numbers only, no repeats, at most 100', () => {
  assert.deepEqual(recallIds('5'), [5]);
  assert.deepEqual(recallIds(['5', '5', 'x', '-1', '7']), [5, 7]);
  assert.deepEqual(recallIds(undefined), []);
  assert.equal(recallIds(Array.from({ length: 150 }, (_, i) => String(i + 1))).length, 100);
});
