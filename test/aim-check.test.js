// In a real test the dot landed ~170px beside the file it described. Before showing the dot,
// Naomi now shows the AI a magnified view with a cross on its chosen spot and lets it correct itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession } = require('../src/main/guide');
const { drawCross } = require('../src/main/imageops');

const shot = { base64: 'A', mediaType: 'image/jpeg', width: 1280, height: 720, toScreen: (p) => p, toImage: (p) => p };
const point = (id, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'point', input: { say: 'Click here.', bubble: 'Click here', action: 'click', type_text: '', target: 'the newest file', ...input } }],
});

function scripted(responses, extra = {}) {
  const calls = [];
  return {
    ...extra,
    calls,
    beta: {
      messages: {
        async create(params) {
          calls.push(structuredClone(params.messages));
          return responses.shift();
        },
      },
    },
  };
}

test('drawCross paints a plus shape on the bitmap', () => {
  const w = 21;
  const h = 21;
  const buf = Buffer.alloc(w * h * 4, 0);
  drawCross(buf, w, h, 10, 10, 5, 1, { r: 255, g: 0, b: 0 });
  const red = (x, y) => buf[(y * w + x) * 4 + 2] === 255;
  assert.ok(red(10, 10), 'center');
  assert.ok(red(5, 10) && red(15, 10), 'horizontal arm ends');
  assert.ok(red(10, 5) && red(10, 15), 'vertical arm ends');
  assert.ok(!red(5, 5) && !red(15, 15), 'corners stay untouched');
});

test('the aim is checked in a marked close-up, and the corrected spot is what the person sees', async () => {
  const client = scripted([
    point('p1', { x: 600, y: 400, from_zoom: false }),
    // In the 900x540 close-up of a 300x180 area at (450, 310), the real target is 20px right of the cross.
    point('p2', { x: 480, y: 270, from_zoom: true }),
  ]);
  const zooms = [];
  const s = new GuideSession({
    client,
    capture: async () => shot,
    zoom: async (region, _shot, mark) => {
      zooms.push({ region, mark });
      return { base64: 'ZOOM', mediaType: 'image/jpeg', width: 900, height: 540 };
    },
  });
  const thinking = [];
  s.on('thinking', (info) => thinking.push(info));
  const pointed = new Promise((r) => s.once('point', r));
  await s.start('find my download');
  const p = await pointed;

  assert.deepEqual(zooms, [{ region: { x: 450, y: 310, width: 300, height: 180 }, mark: { x: 600, y: 400 } }]);
  const check = client.calls[1].at(-1).content[0];
  assert.equal(check.tool_use_id, 'p1');
  assert.match(check.content[0].text, /red cross at \(450, 270\)/);
  assert.equal(check.content[1].source.data, 'ZOOM');
  assert.equal(thinking[1].closer, true);
  assert.deepEqual(p.image, { x: 610, y: 400 });
  assert.equal(p.step, 1, 'the check does not count as a step');
});

test('practice guides and aims from a close look are shown without an extra check', async () => {
  let zoomCalls = 0;
  const zoom = async () => {
    zoomCalls++;
    return { base64: 'Z', mediaType: 'image/jpeg', width: 400, height: 400 };
  };
  const practice = new GuideSession({ client: scripted([point('p1', { x: 100, y: 100, from_zoom: false })], { naomiScripted: true }), capture: async () => shot, zoom });
  const pointed = new Promise((r) => practice.once('point', r));
  await practice.start('practice');
  assert.deepEqual((await pointed).image, { x: 100, y: 100 });
  assert.equal(zoomCalls, 0);

  const noZoom = new GuideSession({ client: scripted([point('p1', { x: 100, y: 100, from_zoom: false })]), capture: async () => shot });
  const pointed2 = new Promise((r) => noZoom.once('point', r));
  await noZoom.start('x');
  assert.deepEqual((await pointed2).image, { x: 100, y: 100 });
});
