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
const { buildLinks, createChainClient } = require('./providers');
const { pointInRect } = require('./geometry');

const Anthropic = AnthropicModule.default || AnthropicModule;
// The island window is mostly transparent and click-through; the pill inside it morphs.
const ISLAND_W = 600;
const ISLAND_H = 600;
const SUMMON_KEY = 'CommandOrControl+Alt+N';
const PRACTICE_GOAL = 'Practice: send an email to my granddaughter';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let island;
let overlay;
let practiceWin = null;
let memory;
let session = null;
let watcher;
let hook = null;
let hookKeys = null;
let dock = 'top';
let pillRect = null; // screen DIP rect of the visible pill, reported by the renderer
let pointerAt = null; // screen DIP point where the dot currently rests
let lastPoint = null; // last pointer message, for "show me again"
let lastState = { phase: 'home' };
const providerHealth = new Map(); // AI providers that failed recently are skipped for a while

// ---------- windows ----------

function islandBoundsFor(side) {
  const wa = primaryDisplay().workArea;
  const width = Math.round(Math.min(ISLAND_W, wa.width - 24));
  const height = Math.round(Math.min(ISLAND_H, wa.height - 24));
  return {
    x: wa.x + Math.round((wa.width - width) / 2),
    y: side === 'top' ? wa.y : wa.y + wa.height - height,
    width,
    height,
  };
}

function createIsland() {
  island = new BrowserWindow({
    ...islandBoundsFor(dock),
    title: 'Naomi',
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'island-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  island.setIgnoreMouseEvents(true, { forward: true });
  // Track the cursor from here, so the pill is clickable the instant the mouse is on it
  // and everything around it stays click-through.
  let overPill = false;
  const hoverTimer = setInterval(() => {
    if (!island || island.isDestroyed() || !pillRect) return;
    const over = pointInRect(screen.getCursorScreenPoint(), pillRect);
    if (over === overPill) return;
    overPill = over;
    island.setIgnoreMouseEvents(!over, { forward: true });
  }, 50);
  island.on('closed', () => clearInterval(hoverTimer));
  island.setAlwaysOnTop(true, 'pop-up-menu');
  island.loadFile(path.join(__dirname, '..', 'renderer', 'island', 'index.html'));
  island.once('ready-to-show', () => island.show());
  island.on('closed', () => app.quit());
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
  // The Windows taskbar re-raises itself above other always-on-top windows (e.g. after it's
  // clicked), which would hide the dot exactly when pointing at a taskbar icon. While pointing,
  // keep reclaiming the top spot.
  const keepOnTop = setInterval(() => {
    if (!lastPoint || !overlay || overlay.isDestroyed()) return;
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.moveTop();
  }, 600);
  overlay.on('closed', () => clearInterval(keepOnTop));
  overlay.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));
  overlay.once('ready-to-show', () => {
    overlay.showInactive();
    overlaySend({ type: 'prefs', spotlight: settings.getPrefs().spotlight });
  });
}

// On Windows every always-on-top window shares one band and the last one raised wins, so
// re-stack ours before pointing: practice window < island < pointer overlay.
function restack() {
  if (practiceWin && !practiceWin.isDestroyed()) practiceWin.setAlwaysOnTop(true, 'floating');
  if (island && !island.isDestroyed()) {
    island.setAlwaysOnTop(true, 'pop-up-menu');
    island.moveTop();
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
  if (island && !island.isDestroyed()) island.webContents.send('naomi:state', state);
}

function sendFeedback(fb) {
  if (island && !island.isDestroyed()) island.webContents.send('naomi:feedback', fb);
}

function prefsForRenderer() {
  return { ...settings.getPrefs(), memoryCount: memory.list().length };
}

// The part of the screen Naomi herself occupies (just the pill, not the transparent window).
function naomiRect() {
  return pillRect || island.getBounds();
}

function setDock(side) {
  dock = side;
  pillRect = null;
  island.setBounds(islandBoundsFor(side));
  island.webContents.send('naomi:dock', side);
}

// If Naomi needs to point at something under the island, the island slides to the other edge.
function keepIslandClear(pt) {
  if (!island || !pointInRect(pt, naomiRect(), 60)) return;
  setDock(dock === 'top' ? 'bottom' : 'top');
}

// Where the dot "comes from" when it first appears: Naomi's face in the island.
function avatarPoint() {
  const r = naomiRect();
  return { x: r.x + 30, y: r.y + Math.min(30, r.height / 2) };
}

function summon() {
  if (!island || island.isDestroyed()) return;
  island.show();
  island.focus();
  island.webContents.send('naomi:summon');
}

// ---------- practice mode ----------

function practiceBounds() {
  const wa = primaryDisplay().workArea;
  const width = Math.round(Math.min(900, wa.width - 40));
  const height = Math.round(Math.min(620, wa.height - 110));
  return { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + wa.height - height - 12, width, height };
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
  if (dock !== 'top') setDock('top');
  const win = await ensurePracticeWindow();
  win.focus();
  startSession(PRACTICE_GOAL, { client: createPracticeClient({ locate: locatePractice }), practice: true });
}

// ---------- seeing the screen ----------

// Hide Naomi (island + dot) for a blink so the AI sees the person's screen, not Naomi.
async function withNaomiHidden(fn) {
  const wins = [overlay, island].filter((w) => w && !w.isDestroyed());
  for (const w of wins) w.setOpacity(0);
  await sleep(90);
  try {
    return await fn();
  } finally {
    for (const w of wins) if (!w.isDestroyed()) w.setOpacity(1);
  }
}

function captureClean() {
  return withNaomiHidden(() => captureForClaude());
}

function captureZoom(region, shot) {
  const a = shot.toScreen({ x: region.x, y: region.y });
  const b = shot.toScreen({ x: region.x + region.width, y: region.y + region.height });
  return withNaomiHidden(() => captureRegion({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }));
}

function signature() {
  const masks = [naomiRect()];
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

// OpenAI -> DeepSeek -> Google (Gemini Flash, then Gemma) -> Claude: whichever keys are set.
function makeClient() {
  if (process.env.NAOMI_MOCK || process.argv.includes('--mock')) return require('./mockClient').createMockClient();
  const links = buildLinks(settings.getKeys(), { Anthropic });
  if (!links.length) return null;
  return createChainClient(links, {
    health: providerHealth,
    onSwitch: (to, from, err) => {
      console.warn(`[naomi] ${from} unavailable (${(err && (err.status || err.message)) || 'error'}); trying ${to}`);
      sendFeedback({ type: 'provider', to });
    },
  });
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
    keepIslandClear(p.screen);
    // Taskbar targets: the dot waits just above the taskbar and an arrow points the rest of the
    // way (Windows draws the taskbar over every app). Clicks are still judged on the real target.
    const { pointerPlacement } = require('./geometry');
    const spot = pointerPlacement(p.screen, primaryDisplay().workArea);
    pointerAt = spot;
    lastPoint = {
      type: 'point',
      ...toOverlay(spot),
      edge: spot.edge,
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
    isNaomiPoint: (pt) => island && pointInRect(pt, naomiRect()),
    isNaomiFocused: () => island && island.isFocused(),
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
  // Island plumbing: remember where the pill is (click-through is decided from the cursor).
  ipcMain.on('naomi:island-rect', (_e, r) => {
    if (!island || island.isDestroyed() || !r) return;
    const b = island.getBounds();
    pillRect = { x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height };
  });

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
    if (dock !== 'top') setDock('top');
    sendState({ phase: 'home' });
  });
  ipcMain.handle('naomi:state:get', () => lastState);
  ipcMain.handle('naomi:prefs:get', () => prefsForRenderer());
  ipcMain.handle('naomi:prefs:set', (_e, patch) => {
    const prefs = settings.setPrefs(patch || {});
    overlaySend({ type: 'prefs', spotlight: prefs.spotlight });
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
    createIsland();
    globalShortcut.register(SUMMON_KEY, summon);
    if (process.argv.includes('--practice')) island.webContents.once('did-finish-load', () => startPractice());
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (hook) hook.stop();
  });
  app.on('window-all-closed', () => app.quit());
}
