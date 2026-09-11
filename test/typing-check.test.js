// A user reported: Naomi pointed at the email's Subject box for the message, and after they typed
// there she went straight to "Send". Naomi now checks where typed text landed, and warns about
// look-alike boxes when checking its aim for a typing step.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GuideSession, describeObservation } = require('../src/main/guide');
const { SYSTEM_PROMPT } = require('../src/main/prompts');

const shot = { base64: 'A', mediaType: 'image/jpeg', width: 1280, height: 720, toScreen: (p) => p, toImage: (p) => p };

test('after typing, Claude is asked whether the text landed in the right box', () => {
  const text = describeObservation({ kind: 'typed', via: 'click', click: { x: 10, y: 10 } }, { input: { target: 'the message area' } }, shot);
  assert.match(text, /did the text land in "the message area"/);
  assert.match(text, /Subject instead of the message area/);
});

test('the prompt explains email boxes and checking before Send', () => {
  assert.match(SYSTEM_PROMPT, /never point at Subject for the message/);
  assert.match(SYSTEM_PROMPT, /Before a final action \(Send/);
  assert.match(SYSTEM_PROMPT, /look at where the text actually landed/);
});

test('the aim check for a typing step warns about look-alike boxes', async () => {
  const calls = [];
  const responses = [
    {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'p1',
          name: 'point',
          input: { say: 'Type your message here.', bubble: 'Type here', action: 'type', x: 600, y: 300, from_zoom: false, type_text: 'I love you', target: 'the message area' },
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
          input: { say: 'Type your message here.', bubble: 'Type here', action: 'type', x: 450, y: 400, from_zoom: true, type_text: 'I love you', target: 'the message area' },
        },
      ],
    },
  ];
  const client = {
    beta: {
      messages: {
        async create(params) {
          calls.push(structuredClone(params.messages));
          return responses.shift();
        },
      },
    },
  };
  const s = new GuideSession({ client, capture: async () => shot, zoom: async () => ({ base64: 'Z', mediaType: 'image/jpeg', width: 900, height: 540 }) });
  const pointed = new Promise((r) => s.once('point', r));
  await s.start('email my granddaughter');
  await pointed;
  const checkText = calls[1].at(-1).content[0].content[0].text;
  assert.match(checkText, /Subject box and the large message area/);
});
