const test = require('node:test');
const assert = require('node:assert/strict');
const { allKeysFromEnv, keysFromEnv, buildLinks, createChainClient } = require('../src/main/providers');

test('spare keys are read, in any letter case, main key first, no repeats', () => {
  const env = { GEMINI_API_KEY: 'g1', GEMINI_API_KEY_Fallback: 'g2', GOOGLE_API_KEY: 'g1', OPENAI_API_KEY: 'o', openai_api_key_2: 'o2' };
  assert.deepEqual(allKeysFromEnv(env), { openai: ['o', 'o2'], google: ['g1', 'g2'] });
  assert.deepEqual(keysFromEnv(env), { openai: 'o', google: 'g1' }, 'main keys unchanged');
  assert.deepEqual(allKeysFromEnv({ GEMINI_API_KEY_FALLBACK: 'only-spare' }), { google: ['only-spare'] });
});

test('Google tries Gemini Flash on the main key, then on the spare key', () => {
  class FakeOpenAI {
    constructor() {
      this.chat = { completions: { create: async () => ({}) } };
    }
  }
  const links = buildLinks({ google: ['g1', 'g2'] }, { OpenAIClass: FakeOpenAI, env: {} });
  assert.deepEqual(links.map((l) => l.name), ['Google Gemini (gemini-3.6-flash)', 'Google Gemini (gemini-3.6-flash, key 2)']);

  // With several models (via NAOMI_GOOGLE_MODEL), the better model is tried on every key first.
  const both = buildLinks({ google: ['g1', 'g2'] }, { OpenAIClass: FakeOpenAI, env: { NAOMI_GOOGLE_MODEL: 'a,b' } });
  assert.deepEqual(both.map((l) => l.name), [
    'Google Gemini (a)',
    'Google Gemini (a, key 2)',
    'Google Gemini (b)',
    'Google Gemini (b, key 2)',
  ]);
});

test('when the first key runs out of free quota, the spare key takes over', async () => {
  const used = [];
  class FakeOpenAI {
    constructor({ apiKey }) {
      this.chat = {
        completions: {
          create: async () => {
            used.push(apiKey);
            if (apiKey === 'g1') throw Object.assign(new Error('quota exceeded'), { status: 429 });
            return { choices: [{ finish_reason: 'stop', message: { content: 'hello' } }] };
          },
        },
      };
    }
  }
  const chain = createChainClient(buildLinks({ google: ['g1', 'g2'] }, { OpenAIClass: FakeOpenAI, env: {} }));
  const res = await chain.beta.messages.create({ system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.content[0].text, 'hello');
  assert.deepEqual(used, ['g1', 'g2']);
  assert.equal(chain.active, 'Google Gemini (gemini-3.6-flash, key 2)');
});
