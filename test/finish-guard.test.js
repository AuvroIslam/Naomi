// Real models have finished a task before the person did anything: once with a false
// "your download is shown — done!", once by giving up with "Open File Explorer and I'll help".
// Naomi must push back and guide instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession } = require('../src/main/guide');

const shot = { base64: 'A', mediaType: 'image/jpeg', width: 1280, height: 720, toScreen: (p) => p, toImage: (p) => p };
const tool = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });

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

test('a first-turn "success" is sent back once, and the session continues', async () => {
  const client = scripted([
    tool('f1', 'finish', { say: 'Your download is shown now!', success: true, remember: [] }),
    tool('a1', 'ask_user', { question: 'Did you download it from the internet just now?', choices: ['Yes', 'No'] }),
  ]);
  const s = new GuideSession({ client, capture: async () => shot });
  let finished = false;
  s.on('finish', () => (finished = true));
  const asked = new Promise((r) => s.once('ask', r));
  await s.start('How do I find the file I just downloaded?');
  assert.match((await asked).question, /download/);
  assert.equal(finished, false);
  const pushBack = client.calls[1].at(-1).content[0];
  assert.equal(pushBack.tool_use_id, 'f1');
  assert.equal(pushBack.is_error, true);
});

test('a first-turn give-up ("open it yourself") is also sent back, and Naomi points instead', async () => {
  const client = scripted([
    tool('f1', 'finish', { say: "Open File Explorer and I'll help you find it.", success: false, remember: [] }),
    tool('p1', 'point', {
      say: 'Click the yellow folder to open File Explorer.',
      bubble: 'Click here',
      action: 'click',
      x: 400,
      y: 700,
      from_zoom: false,
      type_text: '',
      target: 'File Explorer',
    }),
  ]);
  const s = new GuideSession({ client, capture: async () => shot });
  let finished = false;
  s.on('finish', () => (finished = true));
  const pointed = new Promise((r) => s.once('point', r));
  await s.start('How do I find the file I just downloaded?');
  assert.equal((await pointed).target, 'File Explorer');
  assert.equal(finished, false);
});

test('a later finish goes straight through; a first-turn refusal goes through if the model insists', async () => {
  const later = scripted([
    tool('a1', 'ask_user', { question: 'Q?', choices: [] }),
    tool('f1', 'finish', { say: 'Done!', success: true, remember: [] }),
  ]);
  const s1 = new GuideSession({ client: later, capture: async () => shot });
  await s1.start('x');
  const done = new Promise((r) => s1.once('finish', r));
  await s1.reply('yes');
  assert.equal((await done).success, true);

  const cannot = scripted([
    tool('f1', 'finish', { say: "I can't help with that.", success: false, remember: [] }),
    tool('f2', 'finish', { say: "I'm sorry, I really can't help with that one.", success: false, remember: [] }),
  ]);
  const s2 = new GuideSession({ client: cannot, capture: async () => shot });
  const refused = new Promise((r) => s2.once('finish', r));
  await s2.start('x');
  const f = await refused;
  assert.equal(f.success, false);
  assert.match(f.say, /really can't/);
  assert.equal(cannot.calls.length, 2);
});

test('the push-back happens only once per session', async () => {
  const client = scripted([
    tool('f1', 'finish', { say: 'Done!', success: true, remember: [] }),
    tool('f2', 'finish', { say: 'It really is already done.', success: true, remember: [] }),
  ]);
  const s = new GuideSession({ client, capture: async () => shot });
  const done = new Promise((r) => s.once('finish', r));
  await s.start('x');
  assert.equal((await done).say, 'It really is already done.');
  assert.equal(client.calls.length, 2);
});
