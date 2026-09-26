const { contextBridge, ipcRenderer } = require('electron');

// Only the app's own bundled pages (settings/error screens) get this API — the remote
// NovaConnect pages loaded into the same window must not be able to change which server
// the app points at.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('novaconnectSettings', {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (serverUrl) => ipcRenderer.invoke('settings:save', { serverUrl }),
    retry: () => ipcRenderer.invoke('app:retry'),
    openSettings: () => ipcRenderer.invoke('app:open-settings'),
  });
}
