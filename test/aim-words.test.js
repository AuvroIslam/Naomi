// Live in Gmail: Naomi said "Click the message area and type hello", then while re-pointing after
// the aim check the AI rewrote it to "Click in the large blank message box" with nothing to type.
// The check refines only *where*; the step's words, action and text come from the original call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession } = require('../src/main/guide');

const shot = { base64: 'A', mediaType: 'image/jpeg', width: 1280, height: 720, toScreen: (p) => p, toImage: (p) => p };

test('re-pointing after the aim check keeps the original words, action and text to type', async () => {
  const responses = [
    {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'p1',
          name: 'point',
          input: { say: 'Click the message area and type hello.', bubble: 'Type here', action: 'type', x: 600, y: 400, from_zoom: false, type_text: 'hello', target: 'Message body' },
        },
      ],
    },
    {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'p2',
          name: 'point',
          input: { say: 'Click in the large blank message box.', bubble: 'Click here', action: 'click', x: 480, y: 270, from_zoom: true, type_text: '', target: 'Message body' },
        },
      ],
    },
  ];
  const client = { beta: { messages: { create: async () => responses.shift() } } };
  const s = new GuideSession({ client, capture: async () => shot, zoom: async () => ({ base64: 'Z', mediaType: 'image/jpeg', width: 900, height: 540 }) });
  const pointed = new Promise((r) => s.once('point', r));
  await s.start('send an email saying hello');
  const p = await pointed;

  assert.equal(p.say, 'Click the message area and type hello.');
  assert.equal(p.action, 'type');
  assert.equal(p.typeText, 'hello');
  assert.equal(p.bubble, 'Type here');
  // ...but the position is the refined one: (480, 270) in a 900x540 view of 300x180 at (450, 310).
  assert.deepEqual(p.image, { x: 610, y: 400 });
});
