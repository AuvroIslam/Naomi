const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDERS,
  keysFromEnv,
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIResponse,
  buildLinks,
  createChainClient,
} = require('../src/main/providers');
const { TOOLS } = require('../src/main/prompts');
const { GuideSession } = require('../src/main/guide');

const img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });

// Stand-in for the OpenAI SDK: records requests, answers from a script keyed by baseURL.
function fakeOpenAI(script) {
  const requests = [];
  class FakeOpenAI {
    constructor(opts) {
      this.opts = opts;
      this.chat = {
        completions: {
          create: async (body) => {
            requests.push({ baseURL: opts.baseURL, apiKey: opts.apiKey, body: structuredClone(body) });
            const answer = script(body, opts);
            if (answer instanceof Error) throw answer;
            return answer;
          },
        },
      };
    }
  }
  return { FakeOpenAI, requests };
}

const toolCall = (name, args, id = 'call_1') => ({
  model: 'x',
  choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});

test('provider order is OpenAI -> DeepSeek -> Google -> Claude, and all can see', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['openai', 'deepseek', 'google', 'anthropic']);
  assert.deepEqual(PROVIDERS.find((p) => p.id === 'google').models, ['gemini-3.6-flash', 'gemma-4-31b-it']);
  assert.match(PROVIDERS.find((p) => p.id === 'deepseek').models[0], /vision/);
});

test('keysFromEnv reads each provider, accepting GOOGLE_API_KEY too', () => {
  assert.deepEqual(keysFromEnv({ OPENAI_API_KEY: 'o', GOOGLE_API_KEY: 'g' }), { openai: 'o', google: 'g' });
  assert.deepEqual(keysFromEnv({ GEMINI_API_KEY: 'g1', GOOGLE_API_KEY: 'g2', DEEPSEEK_API_KEY: 'd' }), { deepseek: 'd', google: 'g1' });
});

test('messages translate: tool results become tool messages, their screenshots follow', () => {
  const messages = [
    { role: 'user', content: [img('A'), { type: 'text', text: 'goal' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'tool_use', id: 't1', name: 'point', input: { x: 1, y: 2 } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'clicked' }, img('B')] }] },
  ];
  const out = toOpenAIMessages('SYS', messages, { detail: 'high' });
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'SYS');
  assert.equal(out[1].content[0].image_url.url, 'data:image/jpeg;base64,A');
  assert.equal(out[1].content[0].image_url.detail, 'high');
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[2].content, null);
  assert.deepEqual(out[2].tool_calls[0], { id: 't1', type: 'function', function: { name: 'point', arguments: '{"x":1,"y":2}' } });
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 't1', content: 'clicked' });
  assert.equal(out[4].role, 'user');
  assert.equal(out[4].content[1].image_url.url, 'data:image/jpeg;base64,B');
});

test('only the newest screenshots are sent', () => {
  const messages = [1, 2, 3, 4, 5, 6].map((n) => ({ role: 'user', content: [img(String(n)), { type: 'text', text: `t${n}` }] }));
  const out = toOpenAIMessages('S', messages, { keepImages: 2 });
  const urls = out.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === 'image_url');
  assert.deepEqual(urls.map((p) => p.image_url.url.slice(-1)), ['5', '6']);
  assert.equal(out[1].content[0].text, '(earlier screenshot omitted)');
});

test('tools translate; strict only when asked', () => {
  const strict = toOpenAITools(TOOLS, true);
  assert.equal(strict.length, TOOLS.length);
  assert.equal(strict[1].function.name, 'point');
  assert.equal(strict[1].function.strict, true);
  assert.equal(toOpenAITools(TOOLS, false)[1].function.strict, undefined);
});

test('responses translate: tool calls, broken JSON, refusals, plain text', () => {
  const r = fromOpenAIResponse(toolCall('ask_user', { question: 'Q?', choices: [] }));
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.content[0], { type: 'tool_use', id: 'call_1', name: 'ask_user', input: { question: 'Q?', choices: [] } });

  const broken = fromOpenAIResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ function: { name: 'point', arguments: '{x:' } }] } }] });
  assert.deepEqual(broken.content[0].input, {});
  assert.ok(broken.content[0].id);

  assert.equal(fromOpenAIResponse({ choices: [{ finish_reason: 'content_filter', message: {} }] }).stop_reason, 'refusal');
  const text = fromOpenAIResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Which app?' } }] });
  assert.deepEqual(text, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Which app?' }], model: undefined });
  assert.throws(() => fromOpenAIResponse({ choices: [] }));
});

test('each provider gets the right endpoint, model, and parameters', async () => {
  const { FakeOpenAI, requests } = fakeOpenAI(() => toolCall('ask_user', { question: 'Q', choices: [] }));
  const links = buildLinks({ openai: 'ko', deepseek: 'kd', google: 'kg' }, { OpenAIClass: FakeOpenAI, env: {} });
  assert.deepEqual(links.map((l) => l.name), [
    'OpenAI (gpt-5.4-mini)',
    'DeepSeek (deepseek-v4-flash-vision-exp)',
    'Google Gemini (gemini-3.6-flash)',
    'Google Gemini (gemma-4-31b-it)',
  ]);
  const params = { system: 'S', tools: TOOLS, messages: [{ role: 'user', content: [img('A'), { type: 'text', text: 'hi' }] }] };
  for (const l of links) await l.client.beta.messages.create(params);

  const [oa, ds, gm, gemma] = requests;
  assert.equal(oa.baseURL, undefined);
  assert.equal(oa.body.model, 'gpt-5.4-mini');
  assert.equal(oa.body.parallel_tool_calls, false);
  assert.equal(oa.body.max_completion_tokens, 8000);
  assert.equal(oa.body.tools[0].function.strict, true);

  assert.equal(ds.baseURL, 'https://api.deepseek.com');
  assert.equal(ds.apiKey, 'kd');
  assert.equal(ds.body.max_tokens, 8000);
  assert.equal(ds.body.parallel_tool_calls, undefined);

  assert.match(gm.baseURL, /generativelanguage\.googleapis\.com\/v1beta\/openai/);
  assert.equal(gm.body.model, 'gemini-3.6-flash');
  assert.equal(gm.body.reasoning_effort, 'low');
  assert.equal(gemma.body.model, 'gemma-4-31b-it');
});

test('model names can be overridden from the environment', () => {
  const { FakeOpenAI } = fakeOpenAI(() => null);
  const links = buildLinks({ google: 'k' }, { OpenAIClass: FakeOpenAI, env: { NAOMI_GOOGLE_MODEL: 'gemini-3.8-flash' } });
  assert.deepEqual(links.map((l) => l.name), ['Google Gemini (gemini-3.8-flash)']);
});

test('the chain falls through unavailable providers, then sticks with the one that works', async () => {
  const calls = [];
  const link = (name, behaviour) => ({
    name,
    client: {
      beta: {
        messages: {
          create: async () => {
            calls.push(name);
            if (behaviour instanceof Error) throw behaviour;
            return behaviour;
          },
        },
      },
    },
  });
  const switches = [];
  const chain = createChainClient(
    [
      link('openai', Object.assign(new Error('insufficient_quota'), { status: 429 })),
      link('deepseek', Object.assign(new Error('bad key'), { status: 401 })),
      link('google', { stop_reason: 'end_turn', content: [] }),
    ],
    { onSwitch: (to) => switches.push(to) },
  );
  await chain.beta.messages.create({});
  assert.deepEqual(calls, ['openai', 'deepseek', 'google']);
  assert.deepEqual(switches, ['deepseek', 'google']);
  assert.equal(chain.active, 'google');

  calls.length = 0;
  await chain.beta.messages.create({});
  assert.deepEqual(calls, ['google'], 'sticks with the working provider');
});

test('recently failed providers are skipped; if all fail the last error surfaces', async () => {
  let t = 0;
  const health = new Map();
  const failing = (name, status) => ({
    name,
    client: { beta: { messages: { create: async () => { throw Object.assign(new Error(name), { status }); } } } },
  });
  const chain = createChainClient([failing('a', 401), failing('b', 503)], { health, now: () => t });
  await assert.rejects(chain.beta.messages.create({}), (err) => err.status === 503);
  assert.equal(health.size, 2);

  // A later session skips nothing when everything is cooling off — it tries them all again.
  const tried = [];
  const ok = { name: 'c', client: { beta: { messages: { create: async () => (tried.push('c'), { stop_reason: 'end_turn', content: [] }) } } } };
  const next = createChainClient([failing('a', 401), ok], { health, now: () => t });
  await next.beta.messages.create({});
  assert.deepEqual(tried, ['c'], 'a is still cooling off, so c goes first');
  t += 11 * 60 * 1000;
  assert.ok(!(health.get('a') > t), 'cool-off expires');
});

test('a full Naomi step works end-to-end through an OpenAI-compatible provider', async () => {
  const { FakeOpenAI, requests } = fakeOpenAI((body) =>
    body.messages.some((m) => m.role === 'tool')
      ? toolCall('point', { say: 'Click here.', bubble: 'Click here', action: 'click', x: 100, y: 50, from_zoom: false, type_text: '', target: 'Compose' }, 'c2')
      : toolCall('ask_user', { question: 'Do you know her email?', choices: ['Yes', 'No'] }, 'c1'),
  );
  const [link] = buildLinks({ google: 'k' }, { OpenAIClass: FakeOpenAI, env: {} });
  const shot = { base64: 'AAAA', mediaType: 'image/jpeg', width: 1280, height: 720, toScreen: (p) => p, toImage: (p) => p };
  const s = new GuideSession({ client: link.client, capture: async () => shot });
  const asked = new Promise((r) => s.once('ask', r));
  await s.start('email my granddaughter');
  assert.equal((await asked).question, 'Do you know her email?');
  const pointed = new Promise((r) => s.once('point', r));
  await s.reply('No');
  const p = await pointed;
  assert.deepEqual(p.image, { x: 100, y: 50 });
  const second = requests[1].body.messages;
  assert.equal(second.find((m) => m.role === 'tool').tool_call_id, 'c1');
});

test('a point without coordinates is sent back once instead of guessed', async () => {
  let n = 0;
  const client = {
    beta: {
      messages: {
        create: async (params) => {
          n++;
          if (n === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'p1', name: 'point', input: { say: 's', bubble: 'b', action: 'click', target: 't' } }] };
          const last = params.messages.at(-1).content[0];
          assert.equal(last.tool_use_id, 'p1');
          assert.equal(last.is_error, true);
          return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'p2', name: 'point', input: { say: 's', bubble: 'b', action: 'click', x: '640', y: 360, target: 't' } }] };
        },
      },
    },
  };
  const shot = { base64: 'A', mediaType: 'image/jpeg', width: 1280, height: 720, toScreen: (p) => p, toImage: (p) => p };
  const s = new GuideSession({ client, capture: async () => shot });
  const pointed = new Promise((r) => s.once('point', r));
  await s.start('x');
  assert.deepEqual((await pointed).image, { x: 640, y: 360 });
  assert.equal(n, 2);
});
