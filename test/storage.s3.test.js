'use strict';
// The storage module against a REAL S3-compatible server (the unit tests use an in-memory stand-in).
// Skipped unless S3_TEST_ENDPOINT is set; CI starts a SeaweedFS container and sets it:
//   S3_TEST_ENDPOINT=http://127.0.0.1:8333 S3_TEST_BUCKET=nc-test S3_TEST_ACCESS_KEY=... S3_TEST_SECRET_KEY=... node --test test/storage.s3.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const endpoint = process.env.S3_TEST_ENDPOINT;
const skip = endpoint ? false : 'S3_TEST_ENDPOINT is not set';

let storage;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-s3-real-'));
if (!skip) {
  Object.assign(process.env, {
    STORAGE_DRIVER: 's3', S3_ENDPOINT: endpoint, S3_FORCE_PATH_STYLE: 'true', S3_REGION: 'us-east-1',
    S3_BUCKET: process.env.S3_TEST_BUCKET || 'nc-test', S3_ACCESS_KEY_ID: process.env.S3_TEST_ACCESS_KEY, S3_SECRET_ACCESS_KEY: process.env.S3_TEST_SECRET_KEY,
    LOCAL_UPLOAD_ROOT: root,
  });
  storage = require('../src/storage');
}
const tmpFile = (bytes) => { const p = path.join(root, 'u-' + crypto.randomBytes(4).toString('hex')); fs.writeFileSync(p, bytes); return p; };

test('start-up check passes against the real server', { skip }, async () => {
  assert.strictEqual(await storage.selfCheck(), null);
});

test('upload, stream back identical bytes, Range, then delete', { skip }, async () => {
  const bytes = crypto.randomBytes(2 * 1024 * 1024 + 123);
  const stored = await storage.uploadFile({ path: tmpFile(bytes), originalname: 'real.bin', mimetype: 'application/x-real', size: bytes.length });
  assert.strictEqual(stored.driver, 's3');
  const app = express();
  app.use((req, res, next) => { res.render = (v, d) => res.send(d.message); next(); });
  app.get('/f', (req, res) => storage.serveStored(req, res, { key: stored.key, driver: 's3', name: 'real file.bin' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/f`;
  try {
    const full = await fetch(url);
    assert.strictEqual(full.status, 200);
    assert.ok(Buffer.from(await full.arrayBuffer()).equals(bytes));
    assert.strictEqual(full.headers.get('content-type'), 'application/x-real');
    const part = await fetch(url, { headers: { Range: 'bytes=500-1499' } });
    assert.strictEqual(part.status, 206);
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(500, 1500)));
    assert.match(part.headers.get('content-range'), /^bytes 500-1499\//);
  } finally { await new Promise((r) => server.close(r)); }
  assert.ok(await storage.headObject(stored.key));
  await storage.deleteFile(stored.key, 's3');
  assert.strictEqual(await storage.headObject(stored.key), null);
});

test('a missing key reads as missing, and small objects round-trip', { skip }, async () => {
  assert.strictEqual(await storage.readObject('does/not/exist-' + crypto.randomBytes(4).toString('hex')), null);
  const key = 'profile-photos/test-' + crypto.randomBytes(4).toString('hex');
  await storage.writeObject(key, Buffer.from('photo bytes'), 'image/png');
  assert.strictEqual((await storage.readObject(key)).toString(), 'photo bytes');
  await storage.deleteFile(key, 's3');
});
