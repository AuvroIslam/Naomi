// Windows draws the taskbar over every app, so a dot on a taskbar icon would be hidden.
// Found in a real test: "Click the Edge icon on the taskbar" showed only the bubble.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pointerPlacement } = require('../src/main/geometry');

// 1152x720 screen with a 48px taskbar at the bottom (the test machine's layout).
const workArea = { x: 0, y: 0, width: 1152, height: 672 };

test('targets inside the work area are pointed at directly', () => {
  assert.deepEqual(pointerPlacement({ x: 300, y: 200 }, workArea), { x: 300, y: 200, edge: null });
  assert.deepEqual(pointerPlacement({ x: 0, y: 672 }, workArea), { x: 0, y: 672, edge: null });
});

test('a taskbar icon gets the dot above the taskbar, with room for a downward arrow', () => {
  const p = pointerPlacement({ x: 666, y: 696 }, workArea);
  assert.deepEqual(p, { x: 666, y: 626, edge: 'down' });
  // the arrow reaches ~40px below the dot: it must end above the taskbar (y = 672)
  assert.ok(p.y + 40 < 672);
});

test('taskbars on other edges point the right way', () => {
  const leftBar = { x: 60, y: 0, width: 1092, height: 720 };
  assert.deepEqual(pointerPlacement({ x: 24, y: 300 }, leftBar), { x: 106, y: 300, edge: 'left' });
  const topBar = { x: 0, y: 48, width: 1152, height: 672 };
  assert.deepEqual(pointerPlacement({ x: 500, y: 20 }, topBar), { x: 500, y: 94, edge: 'up' });
  const rightBar = { x: 0, y: 0, width: 1092, height: 720 };
  assert.equal(pointerPlacement({ x: 1120, y: 300 }, rightBar).edge, 'right');
});

test('corner targets stay fully on screen', () => {
  assert.deepEqual(pointerPlacement({ x: 1150, y: 719 }, workArea), { x: 1106, y: 626, edge: 'down' });
});
