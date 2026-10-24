// Image thumbnails (Phase 3, "Files"): a picture sent in a channel or chat is shown from a small copy
// (at most 640 px on its longer side, WebP, or JPEG where the ffmpeg build has no WebP encoder)
// instead of the full upload; the full image opens on click. Made with ffmpeg, which the image
// already carries for meeting recordings, so there is no image library to install.
//
// The upload is untrusted: ffmpeg is only ever run on a file whose first bytes say PNG, JPEG, GIF
// or WebP, with that exact decoder forced (no format guessing), one thread, a time limit, and only
// when the picture is at most 50 megapixels. Anything else (an SVG, a PDF called .png, a video)
// simply gets no thumbnail and shows as before. Making a thumbnail never fails an upload.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const THUMB_MAX = 640;
const MAX_PIXELS = 50e6;
const TIMEOUT_MS = 20000;

// The decoder ffmpeg is told to use, from the file's first bytes; null for anything else.
function sniffImage(head) {
  if (!head || head.length < 12) return null;
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png_pipe';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg_pipe';
  const ascii = head.subarray(0, 6).toString('latin1');
  if (ascii === 'GIF87a' || ascii === 'GIF89a') return 'gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp_pipe';
  return null;
}

// The size that fits inside max x max without enlarging; even numbers (some encoders need them).
function fitWithin(width, height, max = THUMB_MAX) {
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.min(1, max / Math.max(width, height));
  const even = (n) => Math.max(2, Math.round(n * scale / 2) * 2);
  return { width: even(width), height: even(height) };
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

async function readHead(file) {
  const fh = await fs.promises.open(file, 'r');
  try { const b = Buffer.alloc(16); const { bytesRead } = await fh.read(b, 0, 16, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); }
}

let webp = null;   // does this ffmpeg have the WebP encoder? asked once
async function hasWebp() {
  if (webp === null) webp = await run('ffmpeg', ['-hide_banner', '-encoders']).then(out => /\blibwebp\b/.test(out), () => false);
  return webp;
}

// From the uploaded file on disk: { buffer, mime, width, height } (width/height of the ORIGINAL,
// so the page can reserve the right space), or null when it gets no thumbnail.
async function makeThumbnail(file) {
  try {
    const decoder = sniffImage(await readHead(file));
    if (!decoder) return null;
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-f', decoder, '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', file]));
    const { width, height } = probe.streams?.[0] || {};
    if (!(width > 0 && height > 0) || width * height > MAX_PIXELS) return null;
    const size = fitWithin(width, height);
    const useWebp = await hasWebp();
    const out = path.join(os.tmpdir(), `nc-thumb-${crypto.randomBytes(6).toString('hex')}.${useWebp ? 'webp' : 'jpg'}`);
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-threads', '1', '-f', decoder, '-i', file, '-frames:v', '1',
        '-vf', `scale=${size.width}:${size.height}:flags=lanczos`,
        ...(useWebp ? ['-c:v', 'libwebp', '-quality', '78'] : ['-q:v', '4']), out]);
      return { buffer: await fs.promises.readFile(out), mime: useWebp ? 'image/webp' : 'image/jpeg', width, height };
    } finally {
      await fs.promises.unlink(out).catch(() => {});
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('thumbnail failed:', String(e.message || e).slice(0, 200));
    return null;   // no ffmpeg here (a dev machine), a broken image, a timeout: show the file as before
  }
}

module.exports = { makeThumbnail, sniffImage, fitWithin, THUMB_MAX, MAX_PIXELS };
