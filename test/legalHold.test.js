const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHold, heldSql, SCOPES } = require('../src/legalHold');

test('a hold needs a name, a kind and a target; the target comes from the field for that kind', () => {
  assert.deepEqual(parseHold({ name: ' Case 42 ', reason: ' audit ', scope_type: 'person', person_id: '7', channel_id: '3' }).value,
    { name: 'Case 42', reason: 'audit', scope_type: 'person', scope_id: 7 });
  assert.equal(parseHold({ name: 'C', scope_type: 'channel', person_id: '7', channel_id: '3' }).value.scope_id, 3);
  assert.equal(parseHold({ name: 'C', scope_type: 'chat', chat_id: '12' }).value.scope_id, 12);
  assert.match(parseHold({ scope_type: 'person', person_id: '7' }).error, /name/);
  assert.match(parseHold({ name: 'x'.repeat(121), scope_type: 'person', person_id: '7' }).error, /120/);
  assert.match(parseHold({ name: 'C', scope_type: 'team', person_id: '7' }).error, /person, a channel or a chat/);
  assert.match(parseHold({ name: 'C', scope_type: 'chat', chat_id: '12; drop' }).error, /chat/);
  assert.match(parseHold({ name: 'C', scope_type: 'channel', channel_id: '0' }).error, /channel/);
  assert.match(parseHold({ name: 'C', scope_type: 'person', person_id: '7', reason: 'r'.repeat(1001) }).error, /1000/);
  assert.deepEqual(Object.keys(SCOPES), ['person', 'channel', 'chat']);
});

test('the held-message condition has no placeholders (knex would read any "?" as a binding) and uses the alias', () => {
  const sql = heldSql('x');
  assert.ok(!sql.includes('?'));
  assert.match(sql, /x\.channel_id/);
  assert.match(sql, /x\.conversation_id/);
  assert.match(sql, /x\.user_id/);
  assert.match(sql, /released_at IS NULL/);
});
