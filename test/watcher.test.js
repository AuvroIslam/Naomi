const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ActionWatcher, KEY } = require('../src/main/watcher');

const FAST = {
  pollMs: 5,
  changePollMs: 10,
  baselineDelayMs: 10,
  minSettleMs: 5,
  doubleClickSettleMs: 15,
  maxSettleMs: 60,
  idleNudgeMs: 60000,
  typingIdleNudgeMs: 60000,
  scrollIdleMs: 20,
  keysSettleMs: 10,
};

const sig = (v) => ({ cols: 4, rows: 1, cells: new Float32Array([v, v, v, v]) });

function setup(opts = {}) {
  const input = new EventEmitter();
  const screen = { current: sig(100) };
  const w = new ActionWatcher({
    input,
    getSignature: async () => screen.current,
    isNaomiPoint: (pt) => pt.x > 1000,
    isNaomiFocused: () => !!opts.focused,
    options: { ...FAST, ...opts.options },
  });
  return { input, screen, w };
}

const once = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('clicking the target gives instant feedback, then finishes as a hit', async () => {
  const { input, w } = setup();
  w.watch({ action: 'click', screen: { x: 200, y: 200 } });
  const hit = once(w, 'hit');
  const done = once(w, 'done');
  input.emit('mousedown', { x: 230, y: 210, button: 1 });
  await hit;
  const obs = await done;
  assert.equal(obs.kind, 'hit');
  assert.deepEqual(obs.click, { x: 230, y: 210 });
  w.dispose();
});

test('clicking elsewhere finishes as a miss; clicks on Naomi are ignored', async () => {
  const { input, w } = setup();
  w.watch({ action: 'click', screen: { x: 200, y: 200 } });
  let hits = 0;
  w.on('hit', () => hits++);
  const done = once(w, 'done');
  input.emit('mousedown', { x: 1200, y: 300 }); // on Naomi's panel
  input.emit('mousedown', { x: 600, y: 500 });
  const obs = await done;
  assert.equal(obs.kind, 'miss');
  assert.deepEqual(obs.click, { x: 600, y: 500 });
  assert.equal(hits, 0);
  w.dispose();
});

test('type step: click box, type, press Enter', async () => {
  const { input, w } = setup();
  w.watch({ action: 'type', screen: { x: 300, y: 300 } });
  const hit = once(w, 'hit');
  input.emit('mousedown', { x: 310, y: 300 });
  assert.equal((await hit).then, 'type');

  const done = once(w, 'done');
  input.emit('keydown', { keycode: KEY.Enter }); // Enter before typing doesn't count
  for (let i = 0; i < 5; i++) input.emit('keydown', { keycode: 30 });
  input.emit('keydown', { keycode: KEY.Enter });
  const obs = await done;
  assert.equal(obs.kind, 'typed');
  assert.equal(obs.via, 'enter');
  w.dispose();
});

test('type step: keys typed into Naomi herself are ignored', async () => {
  const { input, w } = setup({ focused: true });
  w.watch({ action: 'type', screen: { x: 300, y: 300 } });
  let done = false;
  w.on('done', () => (done = true));
  for (let i = 0; i < 5; i++) input.emit('keydown', { keycode: 30 });
  input.emit('keydown', { keycode: KEY.Enter });
  await wait(40);
  assert.equal(done, false);
  w.dispose();
});

test('type step: clicking away after typing finishes the step', async () => {
  const { input, w } = setup();
  w.watch({ action: 'type', screen: { x: 300, y: 300 } });
  input.emit('keydown', { keycode: 30 });
  const done = once(w, 'done');
  input.emit('mousedown', { x: 700, y: 100 });
  const obs = await done;
  assert.equal(obs.kind, 'typed');
  assert.equal(obs.via, 'click');
});

test('a big screen change (e.g. keyboard shortcut) finishes a click step', async () => {
  const { screen, w } = setup();
  w.watch({ action: 'click', screen: { x: 200, y: 200 } });
  await wait(20);
  const done = once(w, 'done');
  screen.current = sig(10);
  assert.equal((await done).kind, 'changed');
});

test('scroll steps finish after the wheel stops', async () => {
  const { input, w } = setup();
  w.watch({ action: 'scroll_down', screen: { x: 200, y: 200 } });
  const done = once(w, 'done');
  input.emit('wheel', {});
  input.emit('wheel', {});
  assert.equal((await done).kind, 'scrolled');
});

test('confirm() finishes immediately; stop() cancels a pending settle', async () => {
  const { input, w } = setup({ options: { minSettleMs: 30 } });
  w.watch({ action: 'look', screen: { x: 1, y: 1 } });
  const done = once(w, 'done');
  w.confirm();
  assert.equal((await done).kind, 'confirmed');

  w.watch({ action: 'click', screen: { x: 200, y: 200 } });
  let finished = false;
  w.on('done', () => (finished = true));
  input.emit('mousedown', { x: 200, y: 200 });
  w.stop();
  await wait(80);
  assert.equal(finished, false);
});

test('idle nudges fire while waiting', async () => {
  const { w } = setup({ options: { idleNudgeMs: 15 } });
  w.watch({ action: 'click', screen: { x: 200, y: 200 } });
  const n = await once(w, 'nudge');
  assert.equal(n.reason, 'idle');
  w.dispose();
});
