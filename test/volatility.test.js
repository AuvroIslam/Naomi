// A video call or animated ad on screen must not look like "the person did something".
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { volatileCells, persistentChange, signatureDiff } = require('../src/main/imageops');
const { ActionWatcher } = require('../src/main/watcher');

const make = (cells) => ({ cols: cells.length, rows: 1, cells: Float32Array.from(cells) });

test('volatileCells flags only the cells that flicker between samples', () => {
  const mask = volatileCells([make([10, 50, 90, 90]), make([10, 80, 90, 90]), make([10, 20, 90, 91])]);
  assert.deepEqual([...mask], [0, 1, 0, 0]);
});

test('signatureDiff can ignore flickering cells', () => {
  const a = make([10, 10, 10, 10]);
  const b = make([200, 10, 10, 10]);
  assert.equal(signatureDiff(a, b), 0.25);
  assert.equal(signatureDiff(a, b, 6, Uint8Array.from([1, 0, 0, 0])), 0);
});

test('persistentChange counts changes that stay put, not ones still moving', () => {
  const base = make([10, 10, 10, 10]);
  // cell 0: changed and steady (real). cell 1: changed but still moving (video). cells 2-3: unchanged.
  const a = make([200, 100, 10, 10]);
  const b = make([201, 180, 10, 10]);
  assert.equal(persistentChange(base, a, b), 0.25);
});

test('a playing video never ends a step, but a real change still does', async () => {
  const input = new EventEmitter();
  const cells = new Array(10).fill(100);
  const w = new ActionWatcher({
    input,
    getSignature: async () => {
      // cells 0-2 are a live video: different on every sample
      for (let i = 0; i < 3; i++) cells[i] = Math.random() * 255;
      return make(cells);
    },
    options: {
      baselineDelayMs: 5,
      volatilitySamples: 3,
      volatilitySampleMs: 5,
      changePollMs: 5,
      confirmMs: 5,
      pollMs: 5,
      maxSettleMs: 40,
      idleNudgeMs: 60000,
    },
  });
  let done = null;
  w.on('done', (obs) => (done = obs));
  w.watch({ action: 'click', screen: { x: 0, y: 0 } });

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(done, null, 'video alone must not end the step');

  for (let i = 5; i < 10; i++) cells[i] = 10; // a new window opened
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(done && done.kind, 'changed');
  w.dispose();
});
