const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  on: (cb) => ipcRenderer.on('overlay:msg', (_e, msg) => cb(msg)),
});
