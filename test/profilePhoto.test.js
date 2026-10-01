const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createProfilePhotoRouter } = require('../src/routes/profilePhoto');
const { initialsSVG } = require('../src/profilePhoto');
test('profile photos require login, validate content, persist and replace only own photo', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-photo-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const app = express();
  app.use('/api/profile-photo', createProfilePhotoRouter({ directory,
    db: { prepare: () => ({ get: async id => id === 7 ? { full_name: 'Test User' } : null }) },
    requireAuth: (req, res, next) => { if (req.headers.authorization !== 'test') return res.sendStatus(401); req.session = { user: { id: 7 } }; next(); }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/profile-photo`;
  assert.equal((await fetch(base + '/7')).status, 401);
  const headers = { Authorization: 'test' };
  const fallback = await fetch(base + '/7', { headers });
  assert.equal(fallback.status, 200); assert.match(await fallback.text(), />TU</);
  const post = async (data, name) => { const body = new FormData(); body.append('file', new Blob([data]), name); body.append('user_id', '99'); return fetch(base, { method: 'POST', headers, body }); };
  assert.equal((await post('<svg onload="alert(1)"/>', 'photo.png')).status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
  assert.equal((await post(png, '../../photo.png')).status, 200);
  assert.deepEqual(await fs.readdir(directory), ['7']);
  const photo = await fetch(base + '/7', { headers });
  assert.equal(photo.headers.get('content-type'), 'image/png');
  assert.equal(photo.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), png);
  assert.equal((await post(png, 'replacement.png')).status, 200);
  assert.equal((await fetch(base + '/99', { headers })).status, 404);
  assert.equal((await post(Buffer.alloc(5 * 1024 * 1024 + 1), 'big.png')).status, 400);
});
test('fallback initials are XML escaped', () => assert.ok(!initialsSVG('<script> &x').includes('<script>')));
