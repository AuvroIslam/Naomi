const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { EventEmitter } = require('node:events');
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const AnthropicModule = require('@anthropic-ai/sdk');
const settings = require('./settings');
const { createMemory } = require('./memory');
const { GuideSession, DEFAULT_MODEL } = require('./guide');
const { ActionWatcher } = require('./watcher');
const { captureForClaude, captureRegion, captureSignature, screenToShot, primaryDisplay } = require('./capture');
const { createPracticeWindow, locateIn } = require('./practice');
const { createPracticeClient } = require('./practiceClient');
const { pointInRect } = require('./geometry');

const Anthropic = AnthropicModule.default || AnthropicModule;
const PANEL_W = 420;
const PANEL_H = 680;
const MARGIN = 16;
const SUMMON_KEY = 'CommandOrControl+Alt+N';
const PRACTICE_GOAL = 'Practice: send an email to my granddaughter';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let panel;
let overlay;
let practiceWin = null;
let memory;
let session = null;
let watcher;
let hook = null;
let hookKeys = null;
let panelSide = 'right';
let pointerAt = null; // screen DIP point where the dot currently rests
let lastPoint = null; // last pointer message, for "show me again"
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

// On Windows every always-on-top window shares one band and the last one raised wins, so
// re-stack ours before pointing: practice window < panel < pointer overlay.
function restack() {
  if (practiceWin && !practiceWin.isDestroyed()) practiceWin.setAlwaysOnTop(true, 'floating');
  if (panel && !panel.isDestroyed()) {
    panel.setAlwaysOnTop(true, 'pop-up-menu');
    panel.moveTop();
  }
  if (overlay && !overlay.isDestroyed()) {
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.moveTop();
  }
}

function overlaySend(msg) {
  if (!overlay || overlay.isDestroyed()) return;
  if (msg.type === 'point') restack();
  overlay.webContents.send('overlay:msg', msg);
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

function prefsForRenderer() {
  return { ...settings.getPrefs(), memoryCount: memory.list().length, summonKey: 'Ctrl + Alt + N' };
}

function movePanelTo(side) {
  panelSide = side;
  panel.setBounds(panelBoundsFor(side));
}

// If Naomi points at something under her own panel, she scoots to the other side.
function keepPanelClear(pt) {
  if (!panel || !pointInRect(pt, panel.getBounds(), 60)) return;
  movePanelTo(panelSide === 'right' ? 'left' : 'right');
}

// Where the dot "comes from" when it first appears: Naomi's face in the panel header.
function avatarPoint() {
  const b = panel.getBounds();
  return { x: b.x + 46, y: b.y + 46 };
}

function summon() {
  if (!panel || panel.isDestroyed()) return;
  if (panel.isMinimized()) panel.restore();
  panel.show();
  panel.focus();
}

// ---------- practice mode ----------

function practiceBounds() {
  const wa = primaryDisplay().workArea;
  const width = Math.round(Math.min(860, wa.width - panelBoundsFor('right').width - MARGIN * 3));
  const height = Math.round(Math.min(640, wa.height - MARGIN * 2));
  return { x: wa.x + MARGIN, y: wa.y + Math.round((wa.height - height) / 2), width, height };
}

async function ensurePracticeWindow() {
  if (practiceWin && !practiceWin.isDestroyed()) {
    if (practiceWin.isMinimized()) practiceWin.restore();
    return practiceWin;
  }
  practiceWin = createPracticeWindow(practiceBounds());
  await new Promise((r) => practiceWin.webContents.once('did-finish-load', r));
  await sleep(200);
  return practiceWin;
}

function closePractice() {
  if (practiceWin && !practiceWin.isDestroyed()) practiceWin.close();
  practiceWin = null;
}

async function locatePractice(id) {
  const win = await ensurePracticeWindow();
  const pt = await locateIn(win, id);
  return pt ? screenToShot(pt) : null;
}

async function startPractice() {
  endSession();
  closePractice();
  movePanelTo('right');
  const win = await ensurePracticeWindow();
  win.focus();
  startSession(PRACTICE_GOAL, { client: createPracticeClient({ locate: locatePractice }), practice: true });
}

// ---------- seeing the screen ----------

// Hide the pointer for a moment so Claude sees the screen, not Naomi's dot.
async function withOverlayHidden(fn) {
  const hide = overlay && !overlay.isDestroyed();
  if (hide) {
    overlay.setOpacity(0);
    await sleep(80);
  }
  try {
    return await fn();
  } finally {
    if (hide) overlay.setOpacity(1);
  }
}

function captureClean() {
  return withOverlayHidden(() => captureForClaude({ maskRects: [panel.getBounds()] }));
}

function captureZoom(region, shot) {
  const a = shot.toScreen({ x: region.x, y: region.y });
  const b = shot.toScreen({ x: region.x + region.width, y: region.y + region.height });
  const rect = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  return withOverlayHidden(() => captureRegion(rect, { maskRects: [panel.getBounds()] }));
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

function hidePointer() {
  pointerAt = null;
  lastPoint = null;
  overlaySend({ type: 'hide' });
}

function endSession() {
  watcher.stop();
  if (session) session.stop();
  session = null;
  hidePointer();
}

function startSession(goal, { client = makeClient(), practice = false } = {}) {
  endSession();
  if (!client) {
    sendState({ phase: 'setup', goal });
    return;
  }
  const prefs = settings.getPrefs();
  const s = new GuideSession({
    client,
    capture: captureClean,
    zoom: captureZoom,
    memories: practice ? [] : memory.list(),
    model: process.env.NAOMI_MODEL || DEFAULT_MODEL,
    effort: process.env.NAOMI_EFFORT || prefs.effort,
  });
  session = s;
  const live = (fn) => (...args) => session === s && fn(...args);
  const state = (st) => sendState({ goal, practice, ...st });

  s.on('thinking', live((info = {}) => {
    watcher.stop();
    overlaySend({ type: 'thinking' });
    const after = lastState.phase === 'thinking' ? lastState.after : lastState.phase;
    state({ phase: 'thinking', after, closer: !!info.closer });
  }));
  s.on('ask', live((q) => {
    hidePointer();
    state({ phase: 'ask', question: q.question, choices: q.choices });
  }));
  s.on('point', live((p) => {
    keepPanelClear(p.screen);
    pointerAt = p.screen;
    lastPoint = {
      type: 'point',
      ...toOverlay(p.screen),
      bubble: p.bubble,
      action: p.action,
      typeText: p.typeText,
      spotlight: settings.getPrefs().spotlight,
    };
    overlaySend({ ...lastPoint, from: toOverlay(avatarPoint()) });
    state({ phase: 'point', step: p.step, say: p.say, action: p.action, typeText: p.typeText, bubble: p.bubble });
    watcher.watch({ action: p.action, screen: p.screen });
  }));
  s.on('keys', live((k) => {
    hidePointer();
    state({ phase: 'keys', step: k.step, say: k.say, keys: k.keys });
    watcher.watch({ action: 'keys' });
  }));
  s.on('finish', live((f) => {
    watcher.stop();
    pointerAt = null;
    lastPoint = null;
    overlaySend({ type: f.success ? 'celebrate' : 'hide' });
    const remembered = f.success && !practice ? memory.add(f.remember) : [];
    state({ phase: 'finish', say: f.say, success: f.success, remembered });
  }));
  s.on('error', live((e) => {
    hidePointer();
    state({ phase: e.kind === 'auth' ? 'setup' : 'error', say: e.message, errorKind: e.kind });
  }));

  s.start(goal).catch((err) => {
    console.error('[naomi] start failed', err);
    state({ phase: 'error', say: "I couldn't see your screen. Let's try again.", errorKind: 'capture' });
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
  ipcMain.handle('naomi:start', (_e, text) => {
    closePractice();
    startSession(String(text || '').slice(0, 1000));
  });
  ipcMain.handle('naomi:practice', () => startPractice());
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
  // "Show me again": the dot travels from Naomi to the target once more.
  ipcMain.handle('naomi:replay', () => {
    if (lastPoint) overlaySend({ ...lastPoint, from: toOverlay(avatarPoint()), replay: true });
  });
  ipcMain.handle('naomi:stop', () => {
    endSession();
    closePractice();
    sendState({ phase: 'home' });
  });
  ipcMain.handle('naomi:state:get', () => lastState);
  ipcMain.handle('naomi:prefs:get', () => prefsForRenderer());
  ipcMain.handle('naomi:prefs:set', (_e, patch) => {
    const prefs = settings.setPrefs(patch || {});
    overlaySend({ type: 'prefs', spotlight: prefs.spotlight });
    return prefsForRenderer();
  });
  ipcMain.handle('naomi:key:set', (_e, key) => {
    settings.setApiKey(String(key || ''));
    return prefsForRenderer();
  });
  ipcMain.handle('naomi:memory:clear', () => {
    memory.clear();
    return prefsForRenderer();
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
  app.on('second-instance', summon);

  app.whenReady().then(() => {
    memory = createMemory(path.join(app.getPath('userData'), 'memory.json'));
    const input = startInputHook();
    wireWatcher(input);
    wireIpc();
    createOverlay();
    createPanel();
    globalShortcut.register(SUMMON_KEY, summon);
    if (process.argv.includes('--practice')) panel.webContents.once('did-finish-load', () => startPractice());
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (hook) hook.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
