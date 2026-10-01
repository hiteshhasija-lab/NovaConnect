function photoType(data) {
  if (data.length > 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && data.toString('ascii', 12, 16) === 'IHDR') {
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
    return width > 0 && height > 0 && width <= 8192 && height <= 8192 ? 'image/png' : null;
  }
  if (data.length > 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 && data[data.length - 2] === 255 && data[data.length - 1] === 217) return 'image/jpeg';
  return null;
}
function initialsSVG(name) {
  const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map(p => Array.from(p)[0]).join('').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[c]);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#e1f1fc"/><text x="32" y="33" dy=".35em" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="600" fill="#183153">' + initials + '</text></svg>';
}
module.exports = { photoType, initialsSVG };
