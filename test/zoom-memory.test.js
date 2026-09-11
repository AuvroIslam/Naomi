const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GuideSession, zoomRegion } = require('../src/main/guide');
const { createMemory } = require('../src/main/memory');

const shot = () => ({
  base64: 'AAAA',
  mediaType: 'image/jpeg',
  width: 1280,
  height: 720,
  toScreen: (p) => ({ x: p.x, y: p.y }),
  toImage: (p) => ({ x: p.x, y: p.y }),
});

function scripted(responses) {
  const calls = [];
  return {
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
const tool = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const once = (e, n) => new Promise((r) => e.once(n, r));

test('zoomRegion centers the area and keeps it inside the screenshot', () => {
  assert.deepEqual(zoomRegion({ x: 100, y: 100, width: 300, height: 200 }, shot()), { x: 0, y: 0, width: 300, height: 200 });
  assert.deepEqual(zoomRegion({ x: 640, y: 360, width: 200, height: 100 }, shot()), { x: 540, y: 310, width: 200, height: 100 });
  assert.deepEqual(zoomRegion({ x: 1270, y: 700, width: 10, height: 10 }, shot()), { x: 1240, y: 680, width: 40, height: 40 });
});

test('zoom_in answers straight away with a magnified crop, and from_zoom points map back', async () => {
  const client = scripted([
    tool('z1', 'zoom_in', { x: 640, y: 360, width: 200, height: 100 }),
    tool('p1', 'point', {
      say: 'Click the paperclip.',
      bubble: 'Click here',
      action: 'click',
      x: 400,
      y: 200,
      from_zoom: true,
      type_text: '',
      target: 'paperclip',
    }),
  ]);
  const zooms = [];
  const s = new GuideSession({
    client,
    capture: async () => shot(),
    zoom: async (region) => {
      zooms.push(region);
      return { base64: 'ZZZZ', mediaType: 'image/jpeg', width: 800, height: 400 };
    },
  });
  const thinking = [];
  s.on('thinking', (info) => thinking.push(info));
  const pointed = once(s, 'point');
  await s.start('attach a file');
  const p = await pointed;

  assert.deepEqual(zooms, [{ x: 540, y: 310, width: 200, height: 100 }]);
  // (400, 200) in an 800x400 zoom of a 200x100 area at (540, 310) -> (640, 360)
  assert.deepEqual(p.image, { x: 640, y: 360 });
  assert.equal(thinking[1].closer, true);
  const zoomResult = client.calls[1][2].content[0];
  assert.equal(zoomResult.tool_use_id, 'z1');
  assert.equal(zoomResult.content[1].source.data, 'ZZZZ');
});

test('zooming is capped so Claude cannot loop', async () => {
  const z = { x: 100, y: 100, width: 100, height: 100 };
  const client = scripted([
    tool('z1', 'zoom_in', z),
    tool('z2', 'zoom_in', z),
    tool('z3', 'zoom_in', z),
    tool('a1', 'ask_user', { question: 'Q', choices: [] }),
  ]);
  let zoomCalls = 0;
  const s = new GuideSession({
    client,
    capture: async () => shot(),
    zoom: async () => {
      zoomCalls++;
      return { base64: 'Z', mediaType: 'image/jpeg', width: 400, height: 400 };
    },
  });
  const asked = once(s, 'ask');
  await s.start('x');
  await asked;
  assert.equal(zoomCalls, 2);
  assert.match(client.calls[3][6].content[0].content[0].text, /point now/);
});

test('memories are shared with Claude, and finish returns facts to remember', async () => {
  const client = scripted([
    tool('a1', 'ask_user', { question: 'Is it your son Rafi?', choices: ['Yes', 'No'] }),
    tool('f1', 'finish', { say: 'Done!', success: true, remember: ['Son Rafi uses WhatsApp', '  ', 5] }),
  ]);
  const s = new GuideSession({ client, capture: async () => shot(), memories: ["Alysa's email: alysa2002@gmail.com"] });
  const asked = once(s, 'ask');
  await s.start('call my son');
  await asked;
  const finished = once(s, 'finish');
  await s.reply('Yes');
  const f = await finished;
  assert.deepEqual(f.remember, ['Son Rafi uses WhatsApp']);
  assert.match(client.calls[0][0].content[1].text, /alysa2002@gmail\.com/);
});

test('memory store dedupes, refuses secrets, caps size, and clears', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naomi-mem-'));
  const mem = createMemory(path.join(dir, 'memory.json'));
  assert.deepEqual(mem.list(), []);
  assert.deepEqual(mem.add(["Alysa's email: alysa2002@gmail.com", 'My password is hunter2', 'Card 4111 1111 1111 1111']), [
    "Alysa's email: alysa2002@gmail.com",
  ]);
  assert.deepEqual(mem.add(["alysa's EMAIL: alysa2002@gmail.com"]), []);
  for (let i = 0; i < 50; i++) mem.add([`fact ${i}`]);
  assert.equal(mem.list().length, 40);
  assert.equal(mem.list().at(-1), 'fact 49');
  mem.clear();
  assert.deepEqual(mem.list(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
