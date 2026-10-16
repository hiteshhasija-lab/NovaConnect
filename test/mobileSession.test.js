const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { createMobileSessionRouter } = require('../src/mobileSession');

test('native session authenticates, rotates cookies, refreshes roles, revokes inactive users and logs out', async t => {
  const user = { id: 7, username: 'tester', full_name: 'Test User', role: 'member', status: 'online', active: 1, password_hash: 'never-exposed', must_change_password: 1 };
  const db = { prepare: sql => ({
    get: async value => sql.includes('username =') ? (value === user.username && user.active ? { ...user } : undefined) : (value === user.id ? { ...user } : undefined),
    run: async (passwordHash, id) => { if (sql.includes('password_hash') && id === user.id) { user.password_hash = passwordHash; user.must_change_password = 0; } },
  }) };
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test-session-secret', resave: false, saveUninitialized: false }));
  app.use('/api/mobile', createMobileSessionRouter({ db, compare: async value => value === 'correct', hash: async value => `hashed:${value}` }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/mobile`;
  let cookie;
  const request = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/session')).status, 401);
  assert.equal((await request('/login', { username: [], password: 'correct' })).status, 400);
  assert.equal((await request('/login', { username: 'tester', password: 'wrong' })).status, 401);
  const first = await request('/login', { username: 'tester', password: 'correct' });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const firstUser = (await first.json()).user;
  assert.equal(firstUser.password_hash, undefined);
  assert.equal(firstUser.must_change_password, true);
  cookie = first.headers.get('set-cookie').split(';')[0];
  const changed = await request('/password', { current_password: 'correct', new_password: 'new-password', confirm_password: 'new-password' });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).user.must_change_password, false);
  const second = await request('/login', { username: 'tester', password: 'correct' });
  const oldCookie = cookie;
  cookie = second.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie, oldCookie);
  assert.equal((await fetch(base + '/session', { headers: { Cookie: oldCookie } })).status, 401);
  user.role = 'admin';
  assert.equal((await (await request('/session')).json()).user.role, 'admin');
  user.active = 0;
  assert.equal((await request('/session')).status, 401);
  user.active = 1;
  const third = await request('/login', { username: 'tester', password: 'correct' });
  cookie = third.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/logout', {})).status, 200);
  assert.equal((await request('/session')).status, 401);
});
