const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('naomi', {
  start: (text) => invoke('naomi:start', text),
  practice: () => invoke('naomi:practice'),
  reply: (text) => invoke('naomi:reply', text),
  confirm: () => invoke('naomi:confirm'),
  stuck: () => invoke('naomi:stuck'),
  retry: () => invoke('naomi:retry'),
  replay: () => invoke('naomi:replay'),
  stop: () => invoke('naomi:stop'),
  getState: () => invoke('naomi:state:get'),
  getPrefs: () => invoke('naomi:prefs:get'),
  setPrefs: (patch) => invoke('naomi:prefs:set', patch),
  clearMemory: () => invoke('naomi:memory:clear'),
  voiceType: () => invoke('naomi:voice-type'),
  windowAction: (action) => invoke('naomi:window', action),
  // island window plumbing
  reportRect: (rect) => ipcRenderer.send('naomi:island-rect', rect),
  onState: (cb) => ipcRenderer.on('naomi:state', (_e, state) => cb(state)),
  onFeedback: (cb) => ipcRenderer.on('naomi:feedback', (_e, fb) => cb(fb)),
  onDock: (cb) => ipcRenderer.on('naomi:dock', (_e, side) => cb(side)),
  onSummon: (cb) => ipcRenderer.on('naomi:summon', () => cb()),
});
