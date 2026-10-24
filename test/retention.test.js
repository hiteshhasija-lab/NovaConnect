const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePolicy, cutoffFor, RETENTION_OPTIONS, summary, removedSomething } = require('../src/retention');

test('only the offered periods are accepted; "forever" and empty keep everything', () => {
  assert.deepEqual(parsePolicy({ channel_days: '365', chat_days: 'forever' }).value, { channel_days: 365, chat_days: null });
  assert.deepEqual(parsePolicy({}).value, { channel_days: null, chat_days: null });
  assert.match(parsePolicy({ channel_days: '1' }).error, /offered/);
  assert.match(parsePolicy({ chat_days: '-30' }).error, /offered/);
  assert.match(parsePolicy({ chat_days: '30; drop table' }).error, /offered/);
  assert.ok(RETENTION_OPTIONS.every((o) => o === null || o >= 30), 'nothing shorter than 30 days');
});

test('the cutoff is that many days before now, in the database time format', () => {
  assert.equal(cutoffFor(30, Date.UTC(2026, 9, 24, 12, 0, 0)), '2026-09-24 12:00:00');
  assert.equal(cutoffFor(365, Date.UTC(2026, 9, 24)), '2025-10-24 00:00:00');
});

test('a run that removed nothing is not worth an audit entry', () => {
  const none = { policy: { channel_days: 30, chat_days: null }, channel: { deleted: 0, cleared: 0, files: 0 }, chat: null, meeting_chat: 0 };
  assert.equal(removedSomething(none), false);
  const some = { ...none, chat: { deleted: 2, cleared: 1, files: 1 } };
  assert.equal(removedSomething(some), true);
  assert.deepEqual(summary(some), { channel_days: 30, chat_days: null, channel_deleted: 0, channel_cleared: 0, chat_deleted: 2, chat_cleared: 1, meeting_chat_deleted: 0, files_deleted: 1 });
});
