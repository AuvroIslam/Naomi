const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession, describeObservation, classifyError } = require('../src/main/guide');

function fakeShot() {
  return {
    base64: 'AAAA',
    mediaType: 'image/jpeg',
    width: 1280,
    height: 720,
    toScreen: (p) => ({ x: p.x * 1.5, y: p.y * 1.5 }),
    toImage: (p) => ({ x: Math.round(p.x / 1.5), y: Math.round(p.y / 1.5) }),
  };
}

// Fake client: returns scripted responses and records every request.
function fakeClient(responses) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(params) {
          calls.push(structuredClone({ ...params, messages: params.messages }));
          const next = responses.shift();
          if (next instanceof Error) throw next;
          return next;
        },
      },
    },
  };
}

const toolUse = (id, name, input) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id, name, input }],
});

const once = (emitter, name) => new Promise((resolve) => emitter.once(name, resolve));

test('start sends screenshot + goal and emits a question', async () => {
  const client = fakeClient([toolUse('t1', 'ask_user', { question: 'Do you know her email?', choices: ['Yes', 'No'] })]);
  const s = new GuideSession({ client, capture: async () => fakeShot() });
  const asked = once(s, 'ask');
  await s.start('send an email to my granddaughter');
  const q = await asked;

  assert.equal(q.question, 'Do you know her email?');
  assert.deepEqual(q.choices, ['Yes', 'No']);
  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.deepEqual(req.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.equal(req.messages[0].content[0].type, 'image');
  assert.match(req.messages[0].content[1].text, /1280x720/);
  assert.match(req.messages[0].content[1].text, /granddaughter/);
});

test('an answer becomes a tool_result for the pending tool, with a fresh screenshot', async () => {
  const client = fakeClient([
    toolUse('t1', 'ask_user', { question: 'Q?', choices: [] }),
    toolUse('t2', 'point', {
      say: 'Click here to write a new email.',
      bubble: 'Click here',
      action: 'click',
      x: 100,
      y: 200,
      type_text: '',
      target: 'the Compose button',
    }),
  ]);
  const s = new GuideSession({ client, capture: async () => fakeShot() });
  await s.start('email');
  const pointed = once(s, 'point');
  await s.reply('No');
  const p = await pointed;

  assert.deepEqual(p.image, { x: 100, y: 200 });
  assert.deepEqual(p.screen, { x: 150, y: 300 });
  assert.equal(p.step, 1);
  assert.equal(p.action, 'click');

  const msgs = client.calls[1].messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].content[0].type, 'thinking', 'assistant content is passed back unchanged');
  const result = msgs[2].content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 't1');
  assert.match(result.content[0].text, /answered: "No"/);
  assert.equal(result.content[1].type, 'image');
});

test('point coordinates are clamped into the screenshot', async () => {
  const client = fakeClient([
    toolUse('t1', 'point', { say: 's', bubble: 'b', action: 'click', x: 5000, y: -20, type_text: '', target: 't' }),
  ]);
  const s = new GuideSession({ client, capture: async () => fakeShot() });
  const pointed = once(s, 'point');
  await s.start('x');
  assert.deepEqual((await pointed).image, { x: 1279, y: 0 });
});

test('report() describes a miss in screenshot pixels', async () => {
  const client = fakeClient([
    toolUse('t1', 'point', { say: 's', bubble: 'b', action: 'click', x: 100, y: 100, type_text: '', target: 'Send' }),
    toolUse('t2', 'finish', { say: 'Done!', success: true }),
  ]);
  const s = new GuideSession({ client, capture: async () => fakeShot() });
  await s.start('x');
  const finished = once(s, 'finish');
  await s.report({ kind: 'miss', click: { x: 900, y: 600 } });
  const f = await finished;
  assert.equal(f.success, true);
  const text = client.calls[1].messages[2].content[0].content[0].text;
  assert.match(text, /somewhere else at \(600, 400\)/);
  assert.match(text, /"Send"/);
});

test('API errors are friendly, keep history valid, and retry() re-sends', async () => {
  const err = Object.assign(new Error('overloaded'), { status: 529 });
  const client = fakeClient([err, toolUse('t1', 'ask_user', { question: 'Q', choices: [] })]);
  const s = new GuideSession({ client, capture: async () => fakeShot() });
  const errored = once(s, 'error');
  await s.start('x');
  assert.equal((await errored).kind, 'busy');
  assert.equal(s.messages.length, 0);

  const asked = once(s, 'ask');
  await s.retry();
  await asked;
  assert.equal(client.calls.length, 2);
  assert.equal(s.messages.length, 2);
});

test('refusal ends kindly; plain text without a tool becomes a question', async () => {
  const refused = new GuideSession({
    client: fakeClient([{ stop_reason: 'refusal', content: [] }]),
    capture: async () => fakeShot(),
  });
  const fin = once(refused, 'finish');
  await refused.start('x');
  assert.equal((await fin).success, false);

  // Plain text first gets one nudge to use a tool; a tool call then goes through normally.
  const nudged = fakeClient([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — Edge is open.' }] },
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'f1', name: 'ask_user', input: { question: 'Is Edge open?', choices: ['Yes'] } }] },
  ]);
  const s = new GuideSession({ client: nudged, capture: async () => fakeShot() });
  const askedAfterNudge = once(s, 'ask');
  await s.start('open edge');
  assert.equal((await askedAfterNudge).question, 'Is Edge open?');
  assert.match(nudged.calls[1].messages.at(-1).content[0].text, /calling exactly one of your tools/);

  // If it keeps talking after the nudge, the words become an open question.
  const texty = new GuideSession({
    client: fakeClient([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hmm.' }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Which app do you use?' }] },
    ]),
    capture: async () => fakeShot(),
  });
  const asked = once(texty, 'ask');
  await texty.start('x');
  assert.equal((await asked).question, 'Which app do you use?');
});

test('stop() silences a session mid-request', async () => {
  let release;
  const client = {
    beta: { messages: { create: () => new Promise((r) => (release = r)) } },
  };
  const s = new GuideSession({ client, capture: async () => fakeShot() });
  let emitted = false;
  s.on('ask', () => (emitted = true));
  const p = s.start('x');
  await new Promise((r) => setImmediate(r));
  s.stop();
  release(toolUse('t1', 'ask_user', { question: 'Q', choices: [] }));
  await p;
  assert.equal(emitted, false);
});

test('a 400 on optional features falls back once to the plain request shape', async () => {
  const bad = Object.assign(new Error('unsupported parameter'), { status: 400 });
  const client = fakeClient([bad, toolUse('t1', 'ask_user', { question: 'Q', choices: [] })]);
  const s = new GuideSession({ client, capture: async () => fakeShot() });
  const asked = once(s, 'ask');
  await s.start('x');
  await asked;
  assert.equal(s.compat, true);
  assert.equal(client.calls[0].fallbacks, 'default');
  assert.equal(client.calls[1].fallbacks, undefined);
  assert.equal(client.calls[1].betas, undefined);
  assert.equal(client.calls[1].output_config, undefined);
  assert.equal(client.calls[1].tools.length, 5);
});

test('classifyError maps statuses to friendly kinds', () => {
  assert.equal(classifyError({ status: 401 }).kind, 'auth');
  assert.equal(classifyError({ status: 429 }).kind, 'busy');
  assert.equal(classifyError({ status: 500 }).kind, 'busy');
  assert.equal(classifyError(new Error('ECONNRESET')).kind, 'offline');
  assert.equal(classifyError({ status: 400, message: 'bad' }).kind, 'unknown');
});

test('describeObservation covers every kind', () => {
  const pending = { input: { target: 'the To box' } };
  const shot = fakeShot();
  for (const kind of ['hit', 'miss', 'changed', 'typed', 'scrolled', 'keys', 'confirmed', 'stuck', 'other']) {
    assert.ok(describeObservation({ kind, click: { x: 30, y: 30 } }, pending, shot).length > 10, kind);
  }
  assert.match(describeObservation({ kind: 'typed', via: 'enter' }, pending, shot), /pressed Enter/);
});
