const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCalls } = require('../src/calls');

function fixture(options) {
  const users = new Map([1, 2, 3].map(id => [id, { id, full_name: `User ${id}`, active: 1 }]));
  const sockets = new Map();
  const events = [];
  let members = [1, 2];
  const io = {
    to: room => ({ emit: (event, data) => events.push({ room, event, data }) }),
    in: room => ({ fetchSockets: async () => [...sockets.values()].filter(s => s.connected && room === `user:${s.user.id}`) })
  };
  const db = { prepare: sql => ({
    get: async id => users.get(id),
    all: async id => sql.includes('dm_participants') && id === 7 ? members.map(id => users.get(id)) : []
  }) };
  const manager = createCalls(io, db, options);
  function socket(id, uid) {
    const handlers = {};
    const s = { id, user: { id: uid }, connected: true,
      request: { session: { user: { id: uid }, reload: cb => cb(null) } },
      on: (event, handler) => { handlers[event] = handler; },
      send: (event, data) => new Promise(resolve => handlers[event](data, resolve)),
      disconnect: () => { s.connected = false; handlers.disconnect(); }
    };
    sockets.set(id, s); manager.attach(s); return s;
  }
  const a = socket('a', 1), b = socket('b', 2), outsider = socket('x', 3);
  return { a, b, outsider, socket, users, events, members: value => { members = value; } };
}
const start = f => f.a.send('call:start', { conversationId: 7, mode: 'audio' });

test('authorized lifecycle relays only between chosen tabs and releases busy state', async () => {
  const f = fixture(); const other = f.socket('other', 2);
  const call = await start(f); assert.equal(call.ok, true);
  assert.equal(f.events[0].event, 'call:incoming');
  assert.equal((await f.outsider.send('call:accept', { id: call.id })).ok, false);
  assert.equal((await f.b.send('call:accept', { id: call.id })).ok, true);
  assert.equal((await other.send('call:accept', { id: call.id })).ok, false);
  const signal = { description: { type: 'offer', sdp: 'v=0' } };
  assert.equal((await other.send('call:signal', { id: call.id, signal })).ok, false);
  assert.equal((await f.a.send('call:signal', { id: call.id, signal })).ok, true);
  assert.equal(f.events.at(-1).room, 'b');
  assert.equal((await f.b.send('call:signal', { id: call.id, signal })).ok, false);
  assert.equal((await f.outsider.send('call:end', { id: call.id })).ok, false);
  assert.equal((await f.a.send('call:end', { id: call.id })).ok, true);
  assert.equal((await f.b.send('call:start', { conversationId: 7, mode: 'video' })).ok, true);
  f.b.disconnect();
});

test('rejects nonmembers, group conversations, inactive and offline users', async () => {
  const f = fixture();
  assert.equal((await f.outsider.send('call:start', { conversationId: 7, mode: 'audio' })).ok, false);
  f.members([1, 2, 3]); assert.equal((await start(f)).ok, false);
  const g = fixture(); g.users.get(2).active = 0; assert.equal((await start(g)).ok, false);
  const h = fixture(); h.b.disconnect(); assert.equal((await start(h)).ok, false);
  const i = fixture(); assert.equal((await i.a.send('call:start', { conversationId: 8, mode: 'audio' })).ok, false);
});

test('refreshes session and account authorization for call actions', async () => {
  const f = fixture(); const call = await start(f);
  f.users.get(2).active = 0;
  assert.equal((await f.b.send('call:accept', { id: call.id })).ok, false);
  f.a.request.session.user = null;
  assert.equal((await f.a.send('call:config', {})).ok, false);
  f.a.disconnect();
});

test('only one simultaneous call reserves a user', async () => {
  const f = fixture(); const a2 = f.socket('a2', 1);
  const replies = await Promise.all([start(f), a2.send('call:start', { conversationId: 7, mode: 'video' })]);
  assert.equal(replies.filter(r => r.ok).length, 1);
  f.a.disconnect(); a2.disconnect();
});

test('decline, expiry, and disconnect end calls', async () => {
  const f = fixture({ ringMs: 15 }); const c = await start(f);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.events.at(-1).data.reason, 'No answer');
  assert.equal((await f.b.send('call:accept', { id: c.id })).ok, false);
  const g = fixture(); const d = await start(g);
  assert.equal((await g.b.send('call:decline', { id: d.id })).ok, true);
  assert.equal(g.events.at(-1).data.reason, 'Call declined');
  const h = fixture(); await start(h); h.a.disconnect();
  assert.equal(h.events.at(-1).data.reason, 'Connection lost');
});

test('connection timeout ends unanswered negotiation but connected calls survive', async () => {
  const f = fixture({ connectMs: 15 }); const c = await start(f);
  await f.b.send('call:accept', { id: c.id });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.events.at(-1).data.reason, 'Unable to connect');
  const g = fixture({ connectMs: 15 }); const d = await start(g);
  await g.b.send('call:accept', { id: d.id });
  await g.a.send('call:connected', { id: d.id }); await g.b.send('call:connected', { id: d.id });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(g.events.some(e => e.event === 'call:ended'), false);
  g.b.disconnect();
});

test('malformed and premature signaling is rejected', async () => {
  const f = fixture();
  assert.equal((await f.a.send('call:start', null)).ok, false);
  assert.equal((await f.a.send('call:start', { conversationId: 7, mode: 'screen' })).ok, false);
  const c = await start(f);
  assert.equal((await f.a.send('call:signal', { id: c.id, signal: { candidate: { candidate: 'x' } } })).ok, false);
  await f.b.send('call:accept', { id: c.id });
  assert.equal((await f.a.send('call:signal', { id: c.id, signal: {} })).ok, false);
  assert.equal((await f.a.send('call:signal', { id: c.id, signal: { description: { type: 'offer', sdp: 'x'.repeat(66000) } } })).ok, false);
  f.a.disconnect();
});
