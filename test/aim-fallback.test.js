// In a live test, after the aim check the AI answered in words instead of pointing again, and the
// person saw an out-of-context "Could you tell me a little more?". Now Naomi shows the point the AI
// already chose, and keeps the conversation valid for the next step.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession } = require('../src/main/guide');

const shot = { base64: 'A', mediaType: 'image/jpeg', width: 1280, height: 720, toScreen: (p) => p, toImage: (p) => p };
const zoom = async () => ({ base64: 'Z', mediaType: 'image/jpeg', width: 900, height: 540 });

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

const pointCall = (id, x, y) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id, name: 'point', input: { say: 'Click Sort.', bubble: 'Sort', action: 'click', x, y, from_zoom: false, type_text: '', target: 'Sort' } }],
});

test('a worded reply to the aim check shows the point the AI already chose', async () => {
  const client = scripted([
    pointCall('p1', 600, 400),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Yes, the cross is right on Sort.' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a1', name: 'ask_user', input: { question: 'Is it sorted now?', choices: ['Yes'] } }] },
  ]);
  const s = new GuideSession({ client, capture: async () => shot, zoom });
  let asked = null;
  s.on('ask', (q) => (asked = q));
  const pointed = new Promise((r) => s.once('point', r));
  await s.start('sort my downloads');
  const p = await pointed;
  assert.deepEqual(p.image, { x: 600, y: 400 });
  assert.equal(p.step, 1);
  assert.equal(asked, null, 'no out-of-context question');

  // The next observation must not reference the already-answered tool call.
  const next = new Promise((r) => s.once('ask', r));
  await s.report({ kind: 'hit' });
  await next;
  const last = client.calls[2].at(-1);
  assert.equal(last.role, 'user');
  assert.ok(last.content.every((b) => b.type !== 'tool_result'), 'sent as plain words, not a stale tool_result');
});

test('an empty reply after a nudge becomes a friendly retryable error, not an empty question', async () => {
  const empty = { stop_reason: 'end_turn', content: [] };
  const client = scripted([empty, empty, pointCall('p1', 100, 100)]);
  const s = new GuideSession({ client, capture: async () => shot });
  let asked = null;
  s.on('ask', (q) => (asked = q));
  const errored = new Promise((r) => s.once('error', r));
  await s.start('x');
  const e = await errored;
  assert.match(e.message, /lost my place/);
  assert.equal(asked, null);

  const pointed = new Promise((r) => s.once('point', r));
  await s.retry();
  assert.deepEqual((await pointed).image, { x: 100, y: 100 });
});
