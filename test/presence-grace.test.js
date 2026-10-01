const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPresenceGrace } = require('../src/presence-grace');
function fixture(preference = 'online') {
  let connected = false;
  const timers = [], writes = [];
  const grace = createPresenceGrace({
    isConnected: () => connected, readPreference: async () => preference,
    write: async (...args) => writes.push(args), now: () => '2026-10-01T12:00:00Z',
    schedule: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    cancel: t => { t.cancelled = true; }
  });
  return { grace, writes, timers, connect: () => { connected = true; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('background goes Away for two minutes then Offline with original last-seen', async () => {
  const f = fixture(); f.grace.disconnect(1, true, assert.fail); await flush();
  assert.deepEqual(f.writes[0], [1, 'away', '2026-10-01T12:00:00Z']);
  assert.equal(f.timers[0].ms, 120000);
  f.timers[0].fn(); await flush();
  assert.deepEqual(f.writes[1], [1, 'offline', '2026-10-01T12:00:00Z']);
});
test('explicit DND and appear offline are respected', async () => {
  for (const status of ['dnd', 'offline']) {
    const f = fixture(status); f.grace.disconnect(1, true, assert.fail); await flush();
    assert.equal(f.writes[0][1], status);
  }
});
test('reconnect cancels old expiry and another live session suppresses Away', async () => {
  const f = fixture(); f.grace.disconnect(1, true, assert.fail);
  f.connect(); await f.grace.reconnect(1);
  f.timers[0].fn(); await flush();
  assert.equal(f.writes.length, 0); assert.equal(f.timers[0].cancelled, true);
});
test('normal disconnection keeps four-second grace without Away', async () => {
  const f = fixture(); f.grace.disconnect(1, false, assert.fail); await flush();
  assert.equal(f.writes.length, 0); assert.equal(f.timers[0].ms, 4000);
  f.timers[0].fn(); await flush(); assert.equal(f.writes[0][1], 'offline');
});
test('reconnect waits for an in-flight disconnect write before restoring presence', async () => {
  let finish; let done = false;
  const g = createPresenceGrace({ isConnected: () => false, readPreference: async () => 'online',
    write: () => new Promise(resolve => { finish = resolve; }), schedule: () => 1, cancel: () => {} });
  g.disconnect(1, true, assert.fail); await flush();
  const settled = g.reconnect(1).then(() => { done = true; });
  await flush(); assert.equal(done, false); finish(); await settled; assert.equal(done, true);
});
