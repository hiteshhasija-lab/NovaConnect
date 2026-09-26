// electron-builder afterPack hook: ad-hoc sign the macOS app before it goes into the DMG.
//
// Without a paid "Developer ID Application" certificate electron-builder skips signing (we set
// identity: null so it doesn't fall back to a personal "Apple Development" cert). But packaging
// modifies the Electron bundle, invalidating its original signature — and on another Mac a
// downloaded app with a broken signature is reported as "damaged" with no way to open it.
// An ad-hoc signature makes it a normal unidentified-developer app instead (one-time
// "Open Anyway" in System Settings > Privacy & Security).
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSignMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // codesign rejects bundles containing extended attributes ("resource fork, Finder information,
  // or similar detritus not allowed") — e.g. provenance/quarantine xattrs on downloaded files.
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
