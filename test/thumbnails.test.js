const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sniffImage, fitWithin, makeThumbnail } = require('../src/thumbnails');

test('only PNG, JPEG, GIF and WebP by their first bytes; a name or a claimed type does not count', () => {
  assert.equal(sniffImage(Buffer.from('89504e470d0a1a0a0000000d', 'hex')), 'png_pipe');
  assert.equal(sniffImage(Buffer.from('ffd8ffe000104a4649460001', 'hex')), 'jpeg_pipe');
  assert.equal(sniffImage(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00', 'latin1')), 'gif');
  assert.equal(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'webp_pipe');
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffImage(Buffer.from('%PDF-1.7\n%âãÏÓ\n')), null);
  assert.equal(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00AVI LIST', 'latin1')), null);
  assert.equal(sniffImage(Buffer.alloc(4)), null);
});

test('fits inside 640 x 640 without enlarging, in even numbers', () => {
  assert.deepEqual(fitWithin(1200, 800), { width: 640, height: 426 });
  assert.deepEqual(fitWithin(800, 3000), { width: 170, height: 640 });
  assert.deepEqual(fitWithin(300, 201), { width: 300, height: 202 });
  assert.deepEqual(fitWithin(1, 1), { width: 2, height: 2 });
  assert.equal(fitWithin(0, 10), null);
});

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('a real picture gets a small thumbnail; anything else gets none', { skip: !hasFfmpeg && 'ffmpeg is not installed here (CI has it)' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-thumb-test-'));
  try {
    const png = path.join(dir, 'big.png');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1200x800', '-frames:v', '1', png]);
    const t = await makeThumbnail(png);
    assert.ok(t, 'no thumbnail for a real PNG');
    assert.equal(t.width, 1200);
    assert.equal(t.height, 800);
    assert.ok(['image/webp', 'image/jpeg'].includes(t.mime));
    assert.ok(t.buffer.length > 100 && t.buffer.length < fs.statSync(png).size, 'thumbnail is not smaller than the original');
    const out = path.join(dir, 'thumb');
    fs.writeFileSync(out, t.buffer);
    const dims = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out]).toString().trim();
    assert.equal(dims, '640,426');
    const fake = path.join(dir, 'fake.png');
    fs.writeFileSync(fake, 'not really a picture at all');
    assert.equal(await makeThumbnail(fake), null);
    const broken = path.join(dir, 'broken.png');
    fs.writeFileSync(broken, Buffer.concat([fs.readFileSync(png).subarray(0, 40)]));
    assert.equal(await makeThumbnail(broken), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
