const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/main/geometry');

test('fitSize keeps aspect ratio and never upscales', () => {
  assert.deepEqual(g.fitSize(2560, 1440, 1280, 800), { width: 1280, height: 720 });
  assert.deepEqual(g.fitSize(1920, 1200, 1280, 800), { width: 1280, height: 800 });
  assert.deepEqual(g.fitSize(800, 600, 1280, 800), { width: 800, height: 600 });
});

test('image <-> screen mapping round-trips on an offset, scaled display', () => {
  const display = { bounds: { x: -1707, y: 0, width: 1707, height: 960 } }; // 2560x1440 @150%
  const image = { width: 1280, height: 720 };
  const s = g.imageToScreen({ x: 640, y: 360 }, image, display);
  assert.deepEqual(s, { x: -1707 + 854, y: 480 });
  const back = g.screenToImage(s, image, display);
  assert.ok(Math.abs(back.x - 640) <= 1 && Math.abs(back.y - 360) <= 1);
});

test('imageToScreen clamps points outside the screenshot', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const image = { width: 1280, height: 720 };
  assert.deepEqual(g.imageToScreen({ x: -50, y: 9999 }, image, display), { x: 0, y: 1080 });
});

test('rectToImage scales a DIP rect into screenshot pixels', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
  const image = { width: 1280, height: 720 };
  assert.deepEqual(g.rectToImage({ x: 1500, y: 400, width: 420, height: 680 }, image, display), {
    x: 1000,
    y: 267,
    width: 280,
    height: 453,
  });
});

test('pointInRect honours margin; distance is euclidean', () => {
  const r = { x: 100, y: 100, width: 50, height: 50 };
  assert.equal(g.pointInRect({ x: 120, y: 120 }, r), true);
  assert.equal(g.pointInRect({ x: 90, y: 120 }, r), false);
  assert.equal(g.pointInRect({ x: 90, y: 120 }, r, 20), true);
  assert.equal(g.distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
});
