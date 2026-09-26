# NovaConnect Desktop (Windows)

A thin Electron shell around the existing NovaConnect web app — the same approach Teams,
Slack, and Discord use for their desktop clients. It doesn't bundle the server, database, or
mediasoup; it just points a native window at your already-running NovaConnect deployment.

## What you get

- A real Windows installer (`.exe`, NSIS) with Start Menu / Desktop shortcuts.
- Minimize-to-tray on close, so the app keeps its socket connection alive in the background
  (same behavior as Teams) instead of fully quitting.
- Camera/mic/notification permissions pre-granted for the app (Electron blocks these by
  default, unlike a normal browser tab).
- A first-run "Connect to NovaConnect" screen to set your server address, remembered after
  that (or bake one in permanently at build time — see below).

## Building the installer

Producing a real Windows `.exe` needs to run on Windows (or CI) — `electron-builder`'s
cross-build support from macOS/Linux for NSIS installers is unreliable without a working Wine
setup. Two ways to get one:

**Option A — GitHub Actions (recommended, no Windows machine needed)**

This repo already has `.github/workflows/build-windows-desktop.yml`. Push to `main` (touching
anything under `electron-app/`), or run it manually from the Actions tab
("Build Windows desktop installer" → "Run workflow"). The finished installer is attached as a
downloadable build artifact named `NovaConnect-Windows-Installer`.

To bake in your server's URL so users are never prompted on first launch, set a repository
variable before running the workflow: **Settings → Secrets and variables → Actions →
Variables → New repository variable**, name `NOVACONNECT_DEFAULT_SERVER_URL`, value your
server's address (e.g. `https://novaconnect.example.com`).

**Option B — On an actual Windows machine**

```
cd electron-app
npm install
npm run dist:win
```

The installer lands in `electron-app/dist/`.

## Development

```
cd electron-app
npm install
npm start
```

## Icon

`build/icon.ico` / `build/icon.png` are placeholder art (a simple "NC" badge in NovaConnect's
brand purple). Swap them for real brand assets whenever you have them — `electron-builder`
picks up `build/icon.ico` automatically for the Windows target.
