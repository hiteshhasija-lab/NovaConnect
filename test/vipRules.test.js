const test = require('node:test');
const assert = require('node:assert/strict');
const { alertFor, unreadFor } = require('../public/js/vip-rules');

const base = { fromMe: false, fromVip: false, myStatus: 'online', level: 'all', mentionsMe: false };

test('your own messages never alert, not even from a VIP list quirk', () => {
  assert.equal(alertFor({ ...base, fromMe: true, fromVip: true }), false);
});

test('chat levels decide as before when nobody is VIP and you are available', () => {
  assert.equal(alertFor(base), true);
  assert.equal(alertFor({ ...base, level: 'mentions' }), false);
  assert.equal(alertFor({ ...base, level: 'mentions', mentionsMe: true }), true);
  assert.equal(alertFor({ ...base, level: 'off', mentionsMe: true }), false);
  for (const myStatus of ['busy', 'away', 'brb', 'incall', 'inmeeting', 'ooo', undefined]) assert.equal(alertFor({ ...base, myStatus }), true, String(myStatus));
});

test('Do not disturb and Presenting silence everyone except VIPs', () => {
  for (const myStatus of ['dnd', 'presenting']) {
    assert.equal(alertFor({ ...base, myStatus }), false);
    assert.equal(alertFor({ ...base, myStatus, mentionsMe: true }), false);
    assert.equal(alertFor({ ...base, myStatus, fromVip: true }), true);
  }
});

test('a VIP gets through muted and mentions-only chats, alert and unread dot', () => {
  assert.equal(alertFor({ ...base, level: 'off', fromVip: true }), true);
  assert.equal(alertFor({ ...base, level: 'mentions', fromVip: true }), true);
  assert.equal(unreadFor({ fromVip: true, level: 'off' }), true);
  assert.equal(unreadFor({ fromVip: false, level: 'off' }), false);
  assert.equal(unreadFor({ fromVip: false, level: 'mentions' }), true);
});
