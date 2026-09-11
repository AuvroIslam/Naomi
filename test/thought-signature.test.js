// Gemini 3 attaches a "thought signature" to each tool call and asks for it back on the next
// request. Naomi keeps it per client and returns it, without ever putting it in the shared history.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLinks, toOpenAIMessages } = require('../src/main/providers');
const { TOOLS } = require('../src/main/prompts');

test('toOpenAIMessages attaches saved provider data to earlier tool calls', () => {
  const extras = new Map([['c1', { google: { thought_signature: 'SIG' } }]]);
  const out = toOpenAIMessages(
    'S',
    [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'ask_user', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Yes' }] },
    ],
    { extras },
  );
  assert.deepEqual(out[2].tool_calls[0].extra_content, { google: { thought_signature: 'SIG' } });
  assert.equal(toOpenAIMessages('S', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'n', input: {} }] }])[1].tool_calls[0].extra_content, undefined);
});

test("a Gemini client sends each tool call's signature back on the next turn", async () => {
  const bodies = [];
  class FakeOpenAI {
    constructor() {
      this.chat = {
        completions: {
          create: async (body) => {
            bodies.push(structuredClone(body));
            return {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `c${bodies.length}`,
                        type: 'function',
                        function: { name: 'ask_user', arguments: '{"question":"Q","choices":[]}' },
                        extra_content: { google: { thought_signature: `SIG${bodies.length}` } },
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      };
    }
  }
  const [link] = buildLinks({ google: 'k' }, { OpenAIClass: FakeOpenAI, env: {} });
  const history = [{ role: 'user', content: 'hi' }];
  const first = await link.client.beta.messages.create({ system: 'S', tools: TOOLS, messages: history });

  // The shared (Anthropic-shaped) history stays clean — no provider-specific fields.
  assert.deepEqual(Object.keys(first.content[0]).sort(), ['id', 'input', 'name', 'type']);

  history.push({ role: 'assistant', content: first.content });
  history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Yes' }] });
  await link.client.beta.messages.create({ system: 'S', tools: TOOLS, messages: history });

  const sent = bodies[1].messages.find((m) => m.role === 'assistant').tool_calls[0];
  assert.equal(sent.id, 'c1');
  assert.deepEqual(sent.extra_content, { google: { thought_signature: 'SIG1' } });
});
