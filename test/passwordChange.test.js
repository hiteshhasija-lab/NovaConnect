const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNewPassword, replacePassword } = require('../src/passwordChange');

test('new password validation enforces length and confirmation', () => {
  assert.match(validateNewPassword('short', 'short'), /at least 8/);
  assert.match(validateNewPassword('long-enough', 'different'), /do not match/);
  assert.equal(validateNewPassword('long-enough', 'long-enough'), null);
});

test('replacing a password clears the required-change flag', async () => {
  let call;
  const db = { prepare: sql => ({ run: async (...values) => { call = { sql, values }; } }) };
  await replacePassword(db, 42, 'temporary-2', async (value, rounds) => `hashed:${value}:${rounds}`);
  assert.match(call.sql, /must_change_password = 0/);
  assert.deepEqual(call.values, ['hashed:temporary-2:10', 42]);
});
