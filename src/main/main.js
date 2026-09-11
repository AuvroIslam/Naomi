const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { EventEmitter } = require('node:events');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const AnthropicModule = require('@anthropic-ai/sdk');
const settings = require('./settings');
const { GuideSession, DEFAULT_MODEL } = require('./guide');
const { ActionWatcher } = require('./watcher');
const { captureForClaude, captureSignature, primaryDisplay } = require('./capture');
const { pointInRect } = require('./geometry');

const Anthropic = AnthropicModule.default || AnthropicModule;
const PANEL_W = 420;
const PANEL_H = 680;
const MARGIN = 16;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let panel;
let overlay;
let session = null;
let watcher;
let hook = null;
let hookKeys = null;
let panelSide = 'right';
let pointerAt = null; // screen DIP point where the dot currently rests
let lastState = { phase: 'home' };

// ---------- windows ----------

// Roughly a third of the screen at most, so Naomi never crowds out what she's pointing at.
function panelBoundsFor(side) {
  const wa = primaryDisplay().workArea;
  const width = Math.round(Math.min(PANEL_W, Math.max(340, wa.width * 0.3)));
  const height = Math.round(Math.min(PANEL_H, wa.height - MARGIN * 2));
  return {
    x: side === 'right' ? wa.x + wa.width - width - MARGIN : wa.x + MARGIN,
    y: wa.y + wa.height - height - MARGIN,
    width,
    height,
  };
}

function createPanel() {
  panel = new BrowserWindow({
    ...panelBoundsFor(panelSide),
    title: 'Naomi',
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Above other always-on-top windows (video-call popouts etc.), just below the pointer overlay.
  panel.setAlwaysOnTop(true, 'pop-up-menu');
  panel.loadFile(path.join(__dirname, '..', 'renderer', 'panel', 'index.html'));
  panel.once('ready-to-show', () => panel.show());
  panel.on('closed', () => app.quit());
}

function createOverlay() {
  const { bounds } = primaryDisplay();
  overlay = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    fullscreenable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));
  overlay.once('ready-to-show', () => {
    overlay.showInactive();
    overlaySend({ type: 'prefs', spotlight: settings.getPrefs().spotlight });
  });
}

function overlaySend(msg) {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:msg', msg);
}

function toOverlay(pt) {
  const { bounds } = primaryDisplay();
  return { x: pt.x - bounds.x, y: pt.y - bounds.y };
}

function sendState(state) {
  lastState = state;
  if (panel && !panel.isDestroyed()) panel.webContents.send('naomi:state', state);
}

function sendFeedback(fb) {
  if (panel && !panel.isDestroyed()) panel.webContents.send('naomi:feedback', fb);
}

// If Naomi points at something under her own panel, she scoots to the other side.
function keepPanelClear(pt) {
  if (!panel || !pointInRect(pt, panel.getBounds(), 60)) return;
  panelSide = panelSide === 'right' ? 'left' : 'right';
  panel.setBounds(panelBoundsFor(panelSide));
}

// Where the dot "comes from" when it first appears: Naomi's face in the panel header.
function avatarPoint() {
  const b = panel.getBounds();
  return { x: b.x + 52, y: b.y + 52 };
}

// ---------- seeing the screen ----------

async function captureClean() {
  const hide = overlay && !overlay.isDestroyed();
  if (hide) {
    overlay.setOpacity(0);
    await sleep(80);
  }
  try {
    return await captureForClaude({ maskRects: [panel.getBounds()] });
  } finally {
    if (hide) overlay.setOpacity(1);
  }
}

function signature() {
  const masks = [panel.getBounds()];
  if (pointerAt) masks.push({ x: pointerAt.x - 430, y: pointerAt.y - 120, width: 860, height: 270 });
  return captureSignature({ maskRects: masks });
}

function startInputHook() {
  const input = new EventEmitter();
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    const toDip = (e) => (process.platform === 'win32' ? screen.screenToDipPoint({ x: e.x, y: e.y }) : { x: e.x, y: e.y });
    uIOhook.on('mousedown', (e) => input.emit('mousedown', { ...toDip(e), button: e.button }));
    uIOhook.on('keydown', (e) => input.emit('keydown', { keycode: e.keycode }));
    uIOhook.on('wheel', () => input.emit('wheel', {}));
    uIOhook.start();
    hook = uIOhook;
    hookKeys = UiohookKey;
  } catch (err) {
    console.warn('[naomi] input hook unavailable; falling back to screen watching:', err.message);
  }
  return input;
}

// ---------- sessions ----------

function makeClient() {
  if (process.env.NAOMI_MOCK || process.argv.includes('--mock')) return require('./mockClient').createMockClient();
  const apiKey = settings.getApiKey();
  return apiKey ? new Anthropic({ apiKey }) : null;
}

function endSession() {
  watcher.stop();
  if (session) session.stop();
  session = null;
  pointerAt = null;
  overlaySend({ type: 'hide' });
}

function startSession(goal) {
  endSession();
  const client = makeClient();
  if (!client) {
    sendState({ phase: 'setup', goal });
    return;
  }
  const prefs = settings.getPrefs();
  const s = new GuideSession({
    client,
    capture: captureClean,
    model: process.env.NAOMI_MODEL || DEFAULT_MODEL,
    effort: process.env.NAOMI_EFFORT || prefs.effort,
  });
  session = s;
  const live = (fn) => (...args) => session === s && fn(...args);

  s.on('thinking', live(() => {
    watcher.stop();
    overlaySend({ type: 'thinking' });
    sendState({ phase: 'thinking', goal, after: lastState.phase });
  }));
  s.on('ask', live((q) => {
    pointerAt = null;
    overlaySend({ type: 'hide' });
    sendState({ phase: 'ask', goal, question: q.question, choices: q.choices });
  }));
  s.on('point', live((p) => {
    keepPanelClear(p.screen);
    pointerAt = p.screen;
    overlaySend({
      type: 'point',
      ...toOverlay(p.screen),
      from: toOverlay(avatarPoint()),
      bubble: p.bubble,
      action: p.action,
      typeText: p.typeText,
      spotlight: settings.getPrefs().spotlight,
    });
    sendState({ phase: 'point', goal, step: p.step, say: p.say, action: p.action, typeText: p.typeText, bubble: p.bubble });
    watcher.watch({ action: p.action, screen: p.screen });
  }));
  s.on('keys', live((k) => {
    pointerAt = null;
    overlaySend({ type: 'hide' });
    sendState({ phase: 'keys', goal, step: k.step, say: k.say, keys: k.keys });
    watcher.watch({ action: 'keys' });
  }));
  s.on('finish', live((f) => {
    watcher.stop();
    pointerAt = null;
    overlaySend({ type: f.success ? 'celebrate' : 'hide' });
    sendState({ phase: 'finish', goal, say: f.say, success: f.success });
  }));
  s.on('error', live((e) => {
    overlaySend({ type: 'hide' });
    sendState({ phase: e.kind === 'auth' ? 'setup' : 'error', goal, say: e.message, errorKind: e.kind });
  }));

  s.start(goal).catch((err) => {
    console.error('[naomi] start failed', err);
    sendState({ phase: 'error', goal, say: "I couldn't see your screen. Let's try again.", errorKind: 'capture' });
  });
}

function wireWatcher(input) {
  watcher = new ActionWatcher({
    input,
    getSignature: signature,
    isNaomiPoint: (pt) => panel && pointInRect(pt, panel.getBounds()),
    isNaomiFocused: () => panel && panel.isFocused(),
  });
  watcher.on('hit', (h) => {
    overlaySend({ type: 'hit', then: h.then });
    sendFeedback({ type: 'hit', then: h.then });
  });
  watcher.on('nudge', (n) => {
    overlaySend({ type: 'nudge' });
    sendFeedback({ type: 'nudge', reason: n.reason });
  });
  watcher.on('done', (obs) => {
    if (session) session.report(obs);
  });
}

// ---------- IPC ----------

function wireIpc() {
  ipcMain.handle('naomi:start', (_e, text) => startSession(String(text || '').slice(0, 1000)));
  ipcMain.handle('naomi:reply', (_e, text) => {
    const t = String(text || '').slice(0, 1000);
    if (!session) return startSession(t);
    watcher.stop();
    return session.reply(t);
  });
  ipcMain.handle('naomi:confirm', () => watcher.confirm());
  ipcMain.handle('naomi:stuck', () => {
    if (!session) return undefined;
    watcher.stop();
    return session.report({ kind: 'stuck' });
  });
  ipcMain.handle('naomi:retry', () => (session ? session.retry() : undefined));
  ipcMain.handle('naomi:stop', () => {
    endSession();
    sendState({ phase: 'home' });
  });
  ipcMain.handle('naomi:state:get', () => lastState);
  ipcMain.handle('naomi:prefs:get', () => settings.getPrefs());
  ipcMain.handle('naomi:prefs:set', (_e, patch) => {
    const prefs = settings.setPrefs(patch || {});
    overlaySend({ type: 'prefs', spotlight: prefs.spotlight });
    return prefs;
  });
  ipcMain.handle('naomi:key:set', (_e, key) => {
    settings.setApiKey(String(key || ''));
    return settings.getPrefs();
  });
  // Windows' built-in voice typing (Win + H) dictates straight into Naomi's text box.
  ipcMain.handle('naomi:voice-type', () => {
    if (!hook || !hookKeys) return false;
    hook.keyTap(hookKeys.H, [hookKeys.Meta]);
    return true;
  });
  ipcMain.handle('naomi:window', (_e, action) => {
    if (action === 'minimize') panel.minimize();
    if (action === 'quit') app.quit();
  });
}

// ---------- app ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (panel) {
      if (panel.isMinimized()) panel.restore();
      panel.focus();
    }
  });

  app.whenReady().then(() => {
    const input = startInputHook();
    wireWatcher(input);
    wireIpc();
    createOverlay();
    createPanel();
  });

  app.on('will-quit', () => {
    if (hook) hook.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
