const { app, BrowserWindow, Menu, Tray, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store({ defaults: { serverUrl: '' } });

// Set this at build time (e.g. `NOVACONNECT_DEFAULT_SERVER_URL=https://meet.example.com npm run dist:win`)
// so a distributed installer already points at your server and users are never prompted on first run.
const BUILT_IN_DEFAULT_SERVER_URL = process.env.NOVACONNECT_DEFAULT_SERVER_URL || '';

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isQuitting = false;

function getServerUrl() {
  return store.get('serverUrl') || BUILT_IN_DEFAULT_SERVER_URL || '';
}

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

  // Keep the app inside its own window for its own pages; anything the page opens as a new
  // tab/window (external links, e.g. a shared file link) goes to the OS's real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(getServerUrl());

  // Minimize-to-tray on close, matching Teams' own "stay signed in in the background" behavior,
  // rather than fully quitting (which would drop socket connections / miss notifications).
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
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
ipcMain.handle('settings:save', (_e, { serverUrl }) => {
  store.set('serverUrl', serverUrl);
  settingsWindow?.close();
  if (mainWindow) {
    mainWindow.loadURL(serverUrl);
    mainWindow.show();
  } else {
    createMainWindow();
  }
  return true;
});

app.whenReady().then(() => {
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
