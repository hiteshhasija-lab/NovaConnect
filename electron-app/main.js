const { app, BrowserWindow, Menu, Tray, ipcMain, session, shell, nativeImage, desktopCapturer, systemPreferences } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({ defaults: { serverUrl: '' } });

// Baked into the packaged package.json at build time
// (`npm run dist:win -- -c.extraMetadata.novaconnectDefaultServerUrl=https://novaconnect.example.com`)
// so a distributed installer already points at your server and users aren't prompted on first run.
// An env var alone wouldn't work: it'd be read on the user's machine at runtime, not at build time.
const BUILT_IN_DEFAULT_SERVER_URL = require('./package.json').novaconnectDefaultServerUrl || '';

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isQuitting = false;

function getServerUrl() {
  return store.get('serverUrl') || BUILT_IN_DEFAULT_SERVER_URL || '';
}

// Camera, microphone and screen sharing only work over https. Installs that saved the plain-http
// address of the server this build points at are moved to its https address on startup.
function upgradeSavedServerToHttps() {
  try {
    const saved = store.get('serverUrl');
    const builtIn = BUILT_IN_DEFAULT_SERVER_URL && new URL(BUILT_IN_DEFAULT_SERVER_URL);
    if (!saved || !builtIn || builtIn.protocol !== 'https:') return;
    const current = new URL(saved);
    if (current.protocol === 'http:' && current.hostname === builtIn.hostname) store.set('serverUrl', builtIn.origin);
  } catch {}
}

// Screen sharing. Unlike a browser, Electron has no built-in screen picker: getDisplayMedia()
// fails unless the app chooses the source itself. This shows our own picker (screens and
// windows, with thumbnails) and hands the chosen source back to the page.
let pickerWindow = null;
let pendingPick = null; // { sources, screenAccess, chosen }

function pickDisplaySource() {
  return new Promise(async (resolve) => {
    if (pickerWindow) { pickerWindow.focus(); resolve(null); return; }
    let sources = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 250 } });
    } catch {}
    // On macOS, without Screen Recording permission only the wallpaper/app's own windows come back.
    const screenAccess = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
    pendingPick = { sources: sources.filter(s => s.name), screenAccess, chosen: null };
    pickerWindow = new BrowserWindow({
      parent: mainWindow || undefined,
      modal: process.platform !== 'darwin',
      width: 760,
      height: 560,
      minimizable: false,
      maximizable: false,
      title: 'Share your screen',
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    pickerWindow.setMenuBarVisibility(false);
    pickerWindow.loadFile(path.join(__dirname, 'picker.html'));
    pickerWindow.on('closed', () => {
      const chosen = pendingPick?.chosen || null;
      pickerWindow = null;
      pendingPick = null;
      resolve(chosen);
    });
  });
}

ipcMain.handle('picker:get', () => ({
  screenAccess: pendingPick?.screenAccess || 'granted',
  sources: (pendingPick?.sources || []).map(s => ({
    id: s.id,
    name: s.name,
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: s.thumbnail.toDataURL(),
  })),
}));
ipcMain.handle('picker:choose', (_e, id) => {
  if (pendingPick) pendingPick.chosen = pendingPick.sources.find(s => s.id === id) || null;
  pickerWindow?.close();
});
ipcMain.handle('picker:open-privacy', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
});

function openSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 260,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'NovaConnect — Server Settings',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 760,
    minHeight: 560,
    title: 'NovaConnect',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#464775',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const menu = Menu.buildFromTemplate([
    {
      label: 'NovaConnect',
      submenu: [
        { label: 'Change Server…', click: openSettingsWindow },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { isQuitting = true; app.quit(); } },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Toggle DevTools', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);

  // Meetings/calls need real camera+mic access — Electron blocks getUserMedia by default
  // unless the host app explicitly grants it, unlike a normal browser's per-site prompt.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'notifications', 'display-capture'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const source = await pickDisplaySource();
    // No video stream means the page's getDisplayMedia() rejects, same as cancelling a browser picker.
    callback(source ? { video: source } : {});
  });

  // Keep the app inside its own window for its own pages; anything the page opens as a new
  // tab/window (external links, e.g. a shared file link) goes to the OS's real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Without this, an unreachable/mistyped server just leaves an empty window with no hint of
  // what went wrong. -3 (ERR_ABORTED) is a navigation superseded by another (e.g. a redirect),
  // not a real failure.
  mainWindow.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    showLoadError(url, description);
  });

  loadServer();

  // Minimize-to-tray on close, matching Teams' own "stay signed in in the background" behavior,
  // rather than fully quitting (which would drop socket connections / miss notifications).
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function showLoadError(url, description) {
  mainWindow.loadFile(path.join(__dirname, 'error.html'), { query: { url, error: description } });
}

function loadServer() {
  // A server address with no host behind it on the LAN (no ARP reply) never fails — the TCP
  // connect just hangs — so did-fail-load alone would leave the window empty indefinitely.
  const url = getServerUrl();
  const timer = setTimeout(() => {
    mainWindow.webContents.stop();
    showLoadError(url, 'The server did not respond within 15 seconds.');
  }, 15000);
  mainWindow.webContents.once('did-stop-loading', () => clearTimeout(timer));
  mainWindow.loadURL(url).catch(() => {});
}

function createTray() {
  // Tray/menu-bar icons are 16pt; macOS draws the image at its full pixel size, so the 1024px
  // app icon must be scaled down (at 2x for sharpness on Retina/high-DPI displays).
  const full = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  const trayIcon = nativeImage.createFromBuffer(full.resize({ width: 32, height: 32 }).toPNG(), { scaleFactor: 2 });
  tray = new Tray(trayIcon);
  tray.setToolTip('NovaConnect');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open NovaConnect', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Change Server…', click: openSettingsWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

ipcMain.handle('settings:get', () => ({ serverUrl: getServerUrl() }));
ipcMain.handle('app:retry', () => { if (mainWindow) loadServer(); });
ipcMain.handle('app:open-settings', () => { openSettingsWindow(); });
ipcMain.handle('settings:save', (_e, { serverUrl }) => {
  store.set('serverUrl', serverUrl);
  settingsWindow?.close();
  if (mainWindow) {
    loadServer();
    mainWindow.show();
  } else {
    createMainWindow();
  }
  return true;
});

// Closing the window only hides it to the tray, so a user double-clicking the shortcut again
// would otherwise start a second, windowless copy. Hand off to the running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else if (settingsWindow) { settingsWindow.focus(); }
    else { openSettingsWindow(); }
  });

  app.whenReady().then(() => {
    upgradeSavedServerToHttps();
    createTray();
    if (getServerUrl()) {
      createMainWindow();
    } else {
      openSettingsWindow();
    }

    app.on('activate', () => {
      if (mainWindow) { mainWindow.show(); }
      else if (getServerUrl()) { createMainWindow(); }
      else { openSettingsWindow(); }
    });
  });
}

app.on('before-quit', () => { isQuitting = true; });
app.on('window-all-closed', () => {
  // Tray keeps the app alive on purpose — quitting is explicit (tray menu / Cmd|Ctrl+Q).
});

// A self-signed/internal CA certificate (e.g. mkcert, common for on-prem deployments like
// this one) would otherwise hard-block the load with no way for the user to proceed. Only
// bypass this for the server the user actually configured, never silently for arbitrary hosts.
app.on('certificate-error', (event, _wc, url, _error, _cert, callback) => {
  try {
    const configured = new URL(getServerUrl()).host;
    if (new URL(url).host === configured) {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch {}
  callback(false);
});
