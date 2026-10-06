'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('locus', {
  call: (method, params) => ipcRenderer.invoke('engine:call', method, params),
  engineReady: () => ipcRenderer.invoke('engine:ready'),
  onEvent: (callback) => {
    const listener = (_e, msg) => callback(msg);
    ipcRenderer.on('engine:event', listener);
    return () => ipcRenderer.removeListener('engine:event', listener);
  },
  fetchJson: (url) => ipcRenderer.invoke('net:json', url),
  openGpx: () => ipcRenderer.invoke('file:openGpx'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  setClearOnQuit: (value) => ipcRenderer.send('app:clearOnQuit', value),
});
