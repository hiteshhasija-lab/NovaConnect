'use strict';
// File storage with an S3 bucket, against an in-memory stand-in for the bucket.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-storage-'));
process.env.STORAGE_DRIVER = 's3';
process.env.S3_BUCKET = 'test-bucket';
process.env.S3_ACCESS_KEY_ID = 'k';
process.env.S3_SECRET_ACCESS_KEY = 's';
process.env.LOCAL_UPLOAD_ROOT = root;
const storage = require('../src/storage');
const { migrate } = require('../src/tools/migrate-uploads-to-s3');

// The bucket: put/get/head/delete by command name, with Range and the "stream needs a length" rule.
function fakeBucket() {
  const objects = new Map();
  const calls = [];
  return {
    objects, calls,
    failWith: null,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      calls.push({ name, key: input.Key });
      if (this.failWith) throw this.failWith;
      if (name === 'PutObjectCommand') {
        assert.ok(Number.isInteger(input.ContentLength), 'a put must carry its length');
        const chunks = [];
        if (Buffer.isBuffer(input.Body)) chunks.push(input.Body); else for await (const c of input.Body) chunks.push(c);
        const body = Buffer.concat(chunks);
        assert.strictEqual(body.length, input.ContentLength);
        objects.set(input.Key, { body, type: input.ContentType });
        return {};
      }
      const obj = objects.get(input.Key);
      if (!obj) throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      if (name === 'HeadObjectCommand') return { ContentLength: obj.body.length, ContentType: obj.type };
      if (name === 'DeleteObjectCommand') { objects.delete(input.Key); return {}; }
      if (name === 'GetObjectCommand') {
        const m = /^bytes=(\d+)-(\d*)$/.exec(input.Range || '');
        if (m) {
          const start = Number(m[1]); const end = m[2] ? Number(m[2]) : obj.body.length - 1;
          const slice = obj.body.subarray(start, end + 1);
          return { Body: Readable.from([slice]), ContentLength: slice.length, ContentRange: `bytes ${start}-${end}/${obj.body.length}`, ContentType: obj.type };
        }
        return { Body: Readable.from([obj.body]), ContentLength: obj.body.length, ContentType: obj.type };
      }
      throw new Error('unexpected command ' + name);
    },
  };
}

async function serve(row) {
  const app = express();
  app.use((req, res, next) => { res.render = (view, d) => res.send(d.message); next(); });
  app.get('/f', (req, res) => storage.serveStored(req, res, row));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/f`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}
const tmpFile = (content) => { const p = path.join(root, 'tmp-' + Math.random().toString(36).slice(2)); fs.writeFileSync(p, content); return p; };

test('an upload goes to the bucket with its length, the temp file is removed, the driver is recorded', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);
  const p = tmpFile('hello bucket');
  const stored = await storage.uploadFile({ path: p, originalname: 'note.txt', mimetype: 'text/plain', size: 12 });
  assert.strictEqual(stored.driver, 's3');
  assert.ok(bucket.objects.has(stored.key));
  assert.strictEqual(bucket.objects.get(stored.key).type, 'text/plain');
  assert.strictEqual(fs.existsSync(p), false);
});

test('blocked types and oversize files are refused with a client status', async () => {
  storage.setS3ClientForTests(fakeBucket());
  await assert.rejects(storage.uploadFile({ path: tmpFile('x'), originalname: 'run.exe', mimetype: 'x', size: 1 }), (e) => e.status === 400 && e.expose);
  await assert.rejects(storage.uploadFile({ path: tmpFile('x'), originalname: 'big.bin', mimetype: 'x', size: storage.MAX_FILE_SIZE + 1 }), (e) => e.status === 413);
});

test('a download streams from the bucket as an attachment, and honours Range', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);
  bucket.objects.set('k1', { body: Buffer.from('0123456789'), type: 'video/mp4' });
  const s = await serve({ key: 'k1', driver: 's3', name: 'my video.mp4' });
  try {
    const full = await fetch(s.base);
    assert.strictEqual(full.status, 200);
    assert.strictEqual(await full.text(), '0123456789');
    assert.match(full.headers.get('content-disposition'), /^attachment;/);
    assert.match(full.headers.get('content-disposition'), /my%20video\.mp4|my video\.mp4/);
    assert.strictEqual(full.headers.get('content-type'), 'video/mp4');
    assert.strictEqual(full.headers.get('accept-ranges'), 'bytes');
    const part = await fetch(s.base, { headers: { Range: 'bytes=2-5' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(await part.text(), '2345');
    assert.strictEqual(part.headers.get('content-range'), 'bytes 2-5/10');
  } finally { await s.close(); }
});

test('a missing object is a 404 page and a storage outage is a 502, not a crash', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);
  const gone = await serve({ key: 'nope', driver: 's3', name: 'x.txt' });
  try { assert.strictEqual((await fetch(gone.base)).status, 404); } finally { await gone.close(); }
  bucket.objects.set('k', { body: Buffer.from('x'), type: 'text/plain' });
  bucket.failWith = Object.assign(new Error('connect ECONNREFUSED'), { name: 'Error' });
  const down = await serve({ key: 'k', driver: 's3', name: 'x.txt' });
  try { const r = await fetch(down.base); assert.strictEqual(r.status, 502); assert.match(await r.text(), /could not be fetched/); } finally { await down.close(); }
});

test('the driver recorded with a file decides, not the current setting: old local files still download and delete', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);   // STORAGE_DRIVER is s3 in this process
  fs.writeFileSync(path.join(root, 'old-file.txt'), 'from disk');
  const s = await serve({ key: 'old-file.txt', driver: 'local', name: 'old.txt' });
  try { const r = await fetch(s.base); assert.strictEqual(r.status, 200); assert.strictEqual(await r.text(), 'from disk'); } finally { await s.close(); }
  const legacy = await serve({ key: 'old-file.txt', driver: null, name: 'old.txt' });   // rows from before drivers were recorded
  try { assert.strictEqual((await fetch(legacy.base)).status, 200); } finally { await legacy.close(); }
  await storage.deleteFile('old-file.txt', 'local');
  assert.strictEqual(fs.existsSync(path.join(root, 'old-file.txt')), false);
  assert.ok(!bucket.calls.some((c) => c.name === 'DeleteObjectCommand'), 'a local file must not trigger a bucket delete');
  bucket.objects.set('in-bucket', { body: Buffer.from('b'), type: 'x' });
  await storage.deleteFile('in-bucket', 's3');
  assert.strictEqual(bucket.objects.has('in-bucket'), false);
});

test('the start-up check passes on a working bucket and names the problem on a broken one', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);
  assert.strictEqual(await storage.selfCheck(), null);
  assert.strictEqual(bucket.objects.size, 0, 'the probe object is cleaned up');
  bucket.failWith = Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' });
  assert.match(await storage.selfCheck(), /NoSuchBucket/);
});

test('migration: dry run changes nothing; --apply copies, verifies and switches rows; a wrong size keeps the row local', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);
  fs.writeFileSync(path.join(root, 'a1.txt'), 'attachment one');
  fs.writeFileSync(path.join(root, 'rec1.mp4'), 'video bytes');
  fs.mkdirSync(path.join(root, 'profile-photos'), { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(root, 'profile-photos', '7'), png);
  const rows = { attachments: [{ storage_key: 'a1.txt', mime_type: 'text/plain', storage_driver: 'local' }, { storage_key: 'gone.txt', mime_type: 'x', storage_driver: 'local' }, { storage_key: 'rec1.mp4', mime_type: 'video/mp4', storage_driver: 'local' }], recordings: [{ storage_key: 'rec1.mp4', storage_driver: 'local' }] };
  const db = { prepare: (sql) => ({
    all: async () => { const t = /FROM (\w+)/.exec(sql)[1]; return rows[t].filter((r) => r.storage_driver === 'local'); },
    run: async (key) => { const t = /UPDATE (\w+)/.exec(sql)[1]; rows[t].forEach((r) => { if (r.storage_key === key && r.storage_driver === 'local') r.storage_driver = 's3'; }); },
  }) };
  const quiet = () => {};
  const dry = await migrate({ db, storage, root, apply: false, log: quiet });
  assert.strictEqual(dry.files, 2); assert.deepStrictEqual(dry.missing, ['gone.txt']); assert.strictEqual(bucket.objects.size, 0);
  assert.ok(rows.attachments.every((r) => r.storage_driver === 'local'));

  const done = await migrate({ db, storage, root, apply: true, log: quiet });
  assert.strictEqual(done.moved, 2); assert.deepStrictEqual(done.errors, []);
  assert.strictEqual(bucket.objects.get('a1.txt').body.toString(), 'attachment one');
  assert.strictEqual(bucket.objects.get('rec1.mp4').type, 'video/mp4');
  assert.ok(bucket.objects.has('profile-photos/7'));
  assert.deepStrictEqual(rows.attachments.map((r) => r.storage_driver), ['s3', 'local', 's3']);   // the missing file stays local
  assert.strictEqual(rows.recordings[0].storage_driver, 's3');
  assert.ok(fs.existsSync(path.join(root, 'a1.txt')), 'local copies stay without --delete-local');

  // a second run has nothing left to do
  const again = await migrate({ db, storage, root, apply: true, log: quiet });
  assert.strictEqual(again.files, 0, 'the rows are s3 now: nothing left to move');
  assert.deepStrictEqual(again.errors, []);
});

test('migration: a copy whose size differs in the bucket is an error and the row is not switched; --delete-local removes verified files', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);
  fs.rmSync(path.join(root, 'profile-photos'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'b1.txt'), 'twelve bytes');
  const row = { storage_key: 'b1.txt', mime_type: 'text/plain', storage_driver: 'local' };
  const db = { prepare: (sql) => ({ all: async () => (/FROM attachments/.test(sql) && row.storage_driver === 'local' ? [row] : []), run: async () => { row.storage_driver = 's3'; } }) };
  const realSend = bucket.send.bind(bucket);
  bucket.send = async (c) => { const r = await realSend(c); if (c.constructor.name === 'HeadObjectCommand' && r.ContentLength) return { ...r, ContentLength: r.ContentLength - 1 }; return r; };
  const bad = await migrate({ db, storage, root, apply: true, log: () => {} });
  assert.strictEqual(bad.errors.length, 1); assert.strictEqual(row.storage_driver, 'local');
  bucket.send = realSend;
  const good = await migrate({ db, storage, root, apply: true, deleteLocal: true, log: () => {} });
  assert.strictEqual(good.moved, 1); assert.strictEqual(row.storage_driver, 's3');
  assert.strictEqual(fs.existsSync(path.join(root, 'b1.txt')), false);
});

test('migration: --delete-local on a later run cleans local copies of files an earlier run already switched', async () => {
  const bucket = fakeBucket(); storage.setS3ClientForTests(bucket);
  fs.rmSync(path.join(root, 'profile-photos'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'c1.txt'), 'kept at first');
  fs.writeFileSync(path.join(root, 'c2.txt'), 'differs in the bucket');
  bucket.objects.set('c1.txt', { body: fs.readFileSync(path.join(root, 'c1.txt')), type: 'text/plain' });
  bucket.objects.set('c2.txt', { body: Buffer.from('short'), type: 'text/plain' });
  const db = { prepare: (sql) => ({ all: async () => (/storage_driver = 's3'/.test(sql) && /FROM attachments/.test(sql) ? [{ storage_key: 'c1.txt' }, { storage_key: 'c2.txt' }] : []), run: async () => {} }) };
  const result = await migrate({ db, storage, root, apply: true, deleteLocal: true, log: () => {} });
  assert.strictEqual(result.cleaned, 1);
  assert.strictEqual(fs.existsSync(path.join(root, 'c1.txt')), false);
  assert.strictEqual(fs.existsSync(path.join(root, 'c2.txt')), true, 'a copy the bucket does not match is kept');
  assert.strictEqual(result.errors.length, 1);
});
