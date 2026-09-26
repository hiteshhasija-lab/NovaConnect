const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novaconnectSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (serverUrl) => ipcRenderer.invoke('settings:save', { serverUrl }),
});
