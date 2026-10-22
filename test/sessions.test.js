const test = require('node:test');
const assert = require('node:assert/strict');

// A stand-in for the Redis client: just enough of scan/mget/del over a Map.
function fakeRedis(entries) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    scan: async (cursor, _m, pattern) => [ '0', [...store.keys()].filter((k) => k.startsWith(pattern.replace('*', ''))) ],
    mget: async (keys) => keys.map((k) => store.get(k) ?? null),
    del: async (...keys) => keys.filter((k) => store.delete(k)).length,
  };
}

test('revokeUserSessions deletes only that person\'s sessions and spares the one making the change', async () => {
  const redis = fakeRedis({
    'nc:sess:a1': JSON.stringify({ user: { id: 7 } }),
    'nc:sess:a2': JSON.stringify({ user: { id: 7 } }),
    'nc:sess:keep': JSON.stringify({ user: { id: 7 } }),
    'nc:sess:b1': JSON.stringify({ user: { id: 8 } }),
    'nc:sess:anon': JSON.stringify({ cookie: {} }),
    'nc:sess:broken': 'not json',
    'other:key': JSON.stringify({ user: { id: 7 } }),
  });
  const path = require.resolve('../src/redis');
  require.cache[path] = { id: path, filename: path, loaded: true, exports: { redis } };
  delete require.cache[require.resolve('../src/sessions')];
  const { revokeUserSessions } = require('../src/sessions');

  assert.equal(await revokeUserSessions(7, 'keep'), 2);
  assert.deepEqual([...redis.store.keys()].sort(), ['nc:sess:anon', 'nc:sess:b1', 'nc:sess:broken', 'nc:sess:keep', 'other:key']);
  assert.equal(await revokeUserSessions(7), 1);          // no exception: the kept one goes too
  assert.equal(redis.store.has('nc:sess:b1'), true);     // someone else's session is untouched
  delete require.cache[path];
});
