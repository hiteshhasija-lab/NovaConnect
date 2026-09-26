# NovaConnect Desktop (Windows + macOS)

A thin Electron shell around the existing NovaConnect web app — the same approach Teams,
Slack, and Discord use for their desktop clients. It doesn't bundle the server, database, or
mediasoup; it just points a native window at your already-running NovaConnect deployment.

## What you get

- **Windows:** an `.exe` installer (NSIS) with Start Menu / Desktop shortcuts.
- **macOS:** `.dmg` disk images for Apple Silicon (`-arm64`) and Intel (`-x64`) Macs.
- Minimize-to-tray on close, so the app keeps its socket connection alive in the background
  (same behavior as Teams) instead of fully quitting. Relaunching brings the window back.
- Camera/mic/notification access for meetings (Electron blocks these by default, unlike a
  normal browser tab; on macOS the system asks once).
- A first-run "Connect to NovaConnect" screen to set the server address, remembered after that.
- A "Can't reach NovaConnect" screen with Try again / Change server if the server is down or
  the address is wrong, instead of an empty window.

## Building

The easiest way is GitHub Actions: `.github/workflows/build-desktop-apps.yml` builds both
platforms on real Windows and macOS runners. It runs on any push to `main` that touches
`electron-app/`, or manually from the Actions tab ("Build desktop apps" → "Run workflow").
Download `NovaConnect-Windows-Installer` and/or `NovaConnect-macOS-DMGs` from the run.

Locally:

```
cd electron-app
npm install
npm run dist:win   # on Windows
npm run dist:mac   # on a Mac
```

On a Mac whose Desktop/Documents are synced with iCloud Drive, build outside the synced
folder or code signing fails ("resource fork, Finder information, or similar detritus not
allowed") — iCloud keeps re-adding attributes to the app bundle:

```
npm run dist:mac -- -c.directories.output=/tmp/novaconnect-build
```

### Baking in the server address

So users are never asked for the server on first launch:

- **CI:** set the repository variable `NOVACONNECT_DEFAULT_SERVER_URL` (Settings → Secrets and
  variables → Actions → Variables) before running the workflow.
- **Locally:** `npm run dist:win -- "-c.extraMetadata.novaconnectDefaultServerUrl=https://novaconnect.example.com"`
  (same for `dist:mac`).

This is written into the packaged app's `package.json` at build time.

## Installing — unsigned builds

Neither build is signed with a paid certificate, so each OS warns once:

- **Windows:** "Windows protected your PC" → **More info** → **Run anyway**.
- **macOS:** open the DMG and drag NovaConnect to Applications. The first launch is blocked
  ("Apple could not verify…") → click **Done**, then **System Settings → Privacy & Security**,
  scroll down to NovaConnect, click **Open Anyway**. The Mac app is ad-hoc signed
  (`scripts/adhoc-sign-mac.js`); without that, macOS would call a downloaded copy "damaged".

Removing these warnings needs a code-signing certificate (Windows) and an Apple
"Developer ID Application" certificate plus notarization (macOS).

## Development

```
cd electron-app
npm install
npm start
```

## Icon

`build/icon.png` (1024px) is the master icon; `build/icon.ico` is generated from it for
Windows, and electron-builder converts the PNG to `.icns` for macOS.
