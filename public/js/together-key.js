(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NovaTogetherKey = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  const clamp = value => Math.max(0, Math.min(1, value));

  // Remove the pure-green background produced by background-effects.js. Video codecs soften and
  // darken green around hair and shoulders, so detection uses green dominance rather than one exact
  // RGB value. A frame is accepted only when green covers a meaningful area or reaches its border;
  // this avoids mistaking a green shirt or object in a normal camera frame for the cutout backdrop.
  function keyFrame(data, width, height) {
    const pixels = Math.floor(data.length / 4);
    const edge = Math.max(1, Math.round(Math.min(width, height) * 0.08));
    let keyed = 0, borderKeyed = 0, borderPixels = 0;

    for (let pixel = 0, offset = 0; pixel < pixels; pixel++, offset += 4) {
      const x = pixel % width, y = Math.floor(pixel / width);
      const border = x < edge || x >= width - edge || y < edge || y >= height - edge;
      if (border) borderPixels++;

      const red = data[offset], green = data[offset + 1], blue = data[offset + 2];
      const other = Math.max(red, blue);
      const dominance = green - other;
      const strength = green >= 72 ? clamp((dominance - 16) / 56) : 0;
      if (strength <= 0) continue;

      data[offset + 3] = Math.min(data[offset + 3], Math.round(255 * (1 - strength)));
      data[offset + 1] = Math.min(green, other + 8); // remove green spill from soft edges
      if (strength >= 0.25) {
        keyed++;
        if (border) borderKeyed++;
      }
    }

    const keyedRatio = pixels ? keyed / pixels : 0;
    const borderRatio = borderPixels ? borderKeyed / borderPixels : 0;
    return { keyed, keyedRatio, borderRatio, ready: keyedRatio >= 0.01 || borderRatio >= 0.10 };
  }

  return { keyFrame };
});
