// A real model once looked at an unrelated dialog and declared "your download is shown — done!"
// before the person had done anything. Naomi must push back instead of celebrating.
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

test('a later success, or an honest first-turn "can\'t do it", goes through', async () => {
  const later = scripted([
    tool('a1', 'ask_user', { question: 'Q?', choices: [] }),
    tool('f1', 'finish', { say: 'Done!', success: true, remember: [] }),
  ]);
  const s1 = new GuideSession({ client: later, capture: async () => shot });
  await s1.start('x');
  const done = new Promise((r) => s1.once('finish', r));
  await s1.reply('yes');
  assert.equal((await done).success, true);

  const cannot = scripted([tool('f1', 'finish', { say: "I can't help with that.", success: false, remember: [] })]);
  const s2 = new GuideSession({ client: cannot, capture: async () => shot });
  const refused = new Promise((r) => s2.once('finish', r));
  await s2.start('x');
  assert.equal((await refused).success, false);
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
