const test = require('node:test');
const assert = require('node:assert/strict');
const { keyFrame } = require('../public/js/together-key');

function frame(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...color, 255], i);
  return data;
}

function paint(data, width, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * width + x) * 4;
    data.set([...color, 255], i);
  }
}

test('Together key removes the green backdrop and keeps the participant opaque', () => {
  const width = 20, height = 20, data = frame(width, height, [18, 224, 22]);
  paint(data, width, 6, 3, 8, 17, [182, 126, 94]);
  const result = keyFrame(data, width, height);
  assert.equal(result.ready, true);
  assert.equal(data[3], 0);
  assert.equal(data[((10 * width + 10) * 4) + 3], 255);
});

test('Together key accepts codec-softened green around a close-up participant', () => {
  const width = 24, height = 24, data = frame(width, height, [48, 142, 43]);
  paint(data, width, 1, 1, 22, 23, [170, 118, 90]);
  const result = keyFrame(data, width, height);
  assert.equal(result.ready, true);
  assert.ok(result.borderRatio >= 0.10);
  assert.ok(data[3] < 80);
});

test('Together key rejects an ordinary frame with an isolated green object', () => {
  const width = 20, height = 20, data = frame(width, height, [95, 105, 118]);
  paint(data, width, 10, 10, 1, 1, [10, 220, 12]);
  const result = keyFrame(data, width, height);
  assert.equal(result.ready, false);
  assert.ok(result.keyedRatio < 0.01);
  assert.equal(result.borderRatio, 0);
});
