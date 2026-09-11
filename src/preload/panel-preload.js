const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('naomi', {
  start: (text) => invoke('naomi:start', text),
  reply: (text) => invoke('naomi:reply', text),
  confirm: () => invoke('naomi:confirm'),
  stuck: () => invoke('naomi:stuck'),
  retry: () => invoke('naomi:retry'),
  stop: () => invoke('naomi:stop'),
  getState: () => invoke('naomi:state:get'),
  getPrefs: () => invoke('naomi:prefs:get'),
  setPrefs: (patch) => invoke('naomi:prefs:set', patch),
  setApiKey: (key) => invoke('naomi:key:set', key),
  voiceType: () => invoke('naomi:voice-type'),
  windowAction: (action) => invoke('naomi:window', action),
  onState: (cb) => ipcRenderer.on('naomi:state', (_e, state) => cb(state)),
  onFeedback: (cb) => ipcRenderer.on('naomi:feedback', (_e, fb) => cb(fb)),
});
