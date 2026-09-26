// electron-builder afterPack hook: give the macOS executables their own Mach-O UUIDs, then sign.
//
// 1. Unique UUIDs. electron-builder doesn't compile anything — it copies Electron's prebuilt
//    executables and renames them, so every Electron app (and every build of this one) shares
//    the same LC_UUIDs. macOS applies Local Network privacy rules by executable UUID, so our
//    app gets conflated with every other app on the Mac built from the same Electron release —
//    e.g. the "Electron" dev app, or an earlier NovaConnect build under another bundle ID — and
//    can be refused LAN access (ERR_ADDRESS_UNREACHABLE) even after the user clicks Allow.
//    The new UUID is derived from the bundle ID + file + original UUID, so it's stable across
//    rebuilds (a user's Allow keeps applying after updates) but unique to this app.
//
// 2. Signing. electron-builder's own signing is off (identity: null) — with no paid "Developer
//    ID Application" certificate it would otherwise pick a cert on its own. Rewriting the
//    executables (and packaging generally) invalidates Electron's original signature, and a
//    downloaded app with a broken signature is reported as "damaged" with no way to open it:
//    - NOVACONNECT_MAC_SIGN_IDENTITY set (e.g. "Apple Development: Name (TEAMID)"): sign with it.
//    - Otherwise: ad-hoc sign (opens after a one-time "Open Anyway").
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LC_UUID = 0x1b;
const MH_MAGIC_64 = 0xfeedfacf;

function rewriteMachOUuid(file, seed) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error(`${file}: expected a thin 64-bit Mach-O (electron-builder builds one arch per app)`);
  }
  const ncmds = buf.readUInt32LE(16);
  let off = 32; // sizeof(mach_header_64)
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const cmdsize = buf.readUInt32LE(off + 4);
    if (cmd === LC_UUID) {
      const original = buf.subarray(off + 8, off + 24);
      const next = crypto.createHash('sha256').update(seed).update(original).digest().subarray(0, 16);
      next[6] = (next[6] & 0x0f) | 0x50; // RFC 4122 version 5-style name-based UUID
      next[8] = (next[8] & 0x3f) | 0x80;
      next.copy(buf, off + 8);
      fs.writeFileSync(file, buf);
      return;
    }
    off += cmdsize;
  }
  throw new Error(`${file}: no LC_UUID load command found`);
}

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const bundleId = context.packager.appInfo.id;

  const executables = [];
  const macosDir = path.join(appPath, 'Contents', 'MacOS');
  for (const f of fs.readdirSync(macosDir)) executables.push(path.join(macosDir, f));
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  for (const helper of fs.readdirSync(frameworksDir).filter((f) => f.endsWith('.app'))) {
    const dir = path.join(frameworksDir, helper, 'Contents', 'MacOS');
    for (const f of fs.readdirSync(dir)) executables.push(path.join(dir, f));
  }
  for (const exe of executables) {
    rewriteMachOUuid(exe, `${bundleId}:${path.relative(appPath, exe)}`);
  }

  const identity = process.env.NOVACONNECT_MAC_SIGN_IDENTITY || '-';
  // codesign rejects bundles containing extended attributes ("resource fork, Finder information,
  // or similar detritus not allowed") — e.g. provenance/quarantine xattrs on downloaded files.
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', identity, appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
