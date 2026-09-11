// Naomi can think with several AI providers. GuideSession always speaks one shape
// (Anthropic-style messages + tools); OpenAI-compatible providers (OpenAI, DeepSeek, Google)
// are translated here. The chain tries providers in order and moves on when one isn't available.

const OpenAIModule = require('openai');

const OpenAI = OpenAIModule.OpenAI || OpenAIModule.default || OpenAIModule;

// Tried in this order. Every model here can see images and call tools.
// Each env name may also have a spare key: e.g. GEMINI_API_KEY_FALLBACK.
const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', env: ['OPENAI_API_KEY'], models: ['gpt-5.4-mini'], openai: true },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    env: ['DEEPSEEK_API_KEY'],
    models: ['deepseek-v4-flash-vision-exp'], // DeepSeek's (experimental) vision model
    baseURL: 'https://api.deepseek.com',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    models: ['gemini-3.6-flash'], // free tier, sees screenshots well, points precisely
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    extra: { reasoning_effort: 'low' },
  },
  { id: 'anthropic', label: 'Claude', env: ['ANTHROPIC_API_KEY'], native: true },
];

const FALLBACK_SUFFIXES = ['_FALLBACK', '_2'];
// Only the last few screenshots are sent to these providers; older ones become a note.
const KEEP_IMAGES = 4;
// A provider that just failed (bad key, no credit, model missing) is skipped for a while.
const COOL_OFF_MS = 10 * 60 * 1000;

// Env names are matched case-insensitively (GEMINI_API_KEY_Fallback works too).
function envLookup(env, name) {
  if (env[name]) return env[name];
  const upper = name.toUpperCase();
  const hit = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return hit ? env[hit] : undefined;
}

// The main key for each provider.
function keysFromEnv(env = process.env) {
  const keys = {};
  for (const p of PROVIDERS) {
    const key = p.env.map((name) => envLookup(env, name)).find(Boolean);
    if (key) keys[p.id] = key;
  }
  return keys;
}

// Every key for each provider, main key first, then spares (…_FALLBACK, …_2), without repeats.
function allKeysFromEnv(env = process.env) {
  const keys = {};
  for (const p of PROVIDERS) {
    const found = [];
    for (const name of p.env) {
      for (const candidate of [name, ...FALLBACK_SUFFIXES.map((s) => name + s)]) {
        const value = (envLookup(env, candidate) || '').trim();
        if (value && !found.includes(value)) found.push(value);
      }
    }
    if (found.length) keys[p.id] = found;
  }
  return keys;
}

function modelsFor(provider, env = process.env) {
  const override = envLookup(env, `NAOMI_${provider.id.toUpperCase()}_MODEL`);
  return override ? override.split(',').map((m) => m.trim()).filter(Boolean) : provider.models;
}

// ---------- Anthropic shape -> OpenAI chat completions ----------

function imagePart(block, detail) {
  const url = `data:${block.source.media_type};base64,${block.source.data}`;
  return { type: 'image_url', image_url: detail ? { url, detail } : { url } };
}

function systemText(system) {
  if (!system) return '';
  return typeof system === 'string' ? system : system.map((b) => b.text || '').join('\n');
}

/**
 * @param {Map<string, object>} [opts.extras] provider data to send back on earlier tool calls,
 *   e.g. Gemini's thought signatures, keyed by tool call id.
 */
function toOpenAIMessages(system, messages, { detail, keepImages = KEEP_IMAGES, extras = null } = {}) {
  const out = [{ role: 'system', content: systemText(system) }];

  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'system') {
      out.push({ role: 'system', content: blocks.map((b) => b.text || '').join('\n') });
      continue;
    }
    if (m.role === 'assistant') {
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          ...(extras && extras.get(b.id) ? { extra_content: extras.get(b.id) } : {}),
        }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }

    // user turn: tool results become `tool` messages; their screenshots follow in a user message
    const rest = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : b.content || [];
        const text = parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text || 'Done.' });
        for (const p of parts) if (p.type === 'image') rest.push(imagePart(p, detail));
      } else if (b.type === 'text') {
        rest.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        rest.push(imagePart(b, detail));
      }
    }
    if (rest.length) {
      if (!rest.some((p) => p.type === 'text')) rest.unshift({ type: 'text', text: 'Here is the screen now.' });
      out.push({ role: 'user', content: rest });
    }
  }

  // Keep the newest screenshots only.
  let seen = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (!Array.isArray(out[i].content)) continue;
    out[i].content = out[i].content.map((p) => {
      if (p.type !== 'image_url') return p;
      seen++;
      return seen > keepImages ? { type: 'text', text: '(earlier screenshot omitted)' } : p;
    });
  }
  return out;
}

function toOpenAITools(tools, strict) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema, ...(strict ? { strict: true } : {}) },
  }));
}

// ---------- OpenAI chat completion -> Anthropic shape ----------

let callCounter = 0;

function fromOpenAIResponse(completion) {
  const choice = completion && completion.choices && completion.choices[0];
  if (!choice) throw Object.assign(new Error('The AI sent back an empty answer'), { status: 502 });
  const msg = choice.message || {};
  const content = [];
  const text = Array.isArray(msg.content) ? msg.content.map((p) => p.text || '').join('') : msg.content;
  if (text) content.push({ type: 'text', text });

  const call = (msg.tool_calls || []).find((c) => c && c.function);
  if (call) {
    let input = {};
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: call.id || `call_${Date.now()}_${++callCounter}`, name: call.function.name, input });
  }
  const stopReason = choice.finish_reason === 'content_filter' ? 'refusal' : call ? 'tool_use' : 'end_turn';
  return { stop_reason: stopReason, content, model: completion.model };
}

// ---------- clients ----------

function createOpenAICompatClient({ provider, model, apiKey, OpenAIClass = OpenAI }) {
  const client = new OpenAIClass({ apiKey, baseURL: provider.baseURL, maxRetries: 1, timeout: 60_000 });
  // Provider data that must travel with a tool call (Gemini's thought signatures), kept here
  // rather than in the shared history so other providers never see it.
  const extras = new Map();
  return {
    beta: {
      messages: {
        async create(params) {
          const body = {
            model,
            messages: toOpenAIMessages(params.system, params.messages, { detail: provider.openai ? 'high' : undefined, extras }),
            tools: toOpenAITools(params.tools, !!provider.openai),
            tool_choice: 'auto',
            ...(provider.openai ? { parallel_tool_calls: false, max_completion_tokens: 8000 } : { max_tokens: 8000 }),
            // Gemma rejects Gemini's thinking settings, so extras only go to non-Gemma models.
            ...(provider.extra && !/^gemma/i.test(model) ? provider.extra : {}),
          };
          const completion = await client.chat.completions.create(body);
          const message = completion && completion.choices && completion.choices[0] && completion.choices[0].message;
          for (const call of (message && message.tool_calls) || []) {
            if (call && call.id && call.extra_content) extras.set(call.id, call.extra_content);
          }
          return fromOpenAIResponse(completion);
        },
      },
    },
  };
}

/**
 * One link per (provider, model, key), in fallback order. Within a provider the better model is
 * tried with every key before dropping to the next model (a used-up free quota on key 1 moves
 * to key 2, not straight to a weaker model).
 * @param {Record<string, string|string[]>} keys
 */
function buildLinks(keys, { OpenAIClass = OpenAI, Anthropic = null, env = process.env } = {}) {
  const links = [];
  for (const provider of PROVIDERS) {
    const list = [].concat(keys[provider.id] || []).filter(Boolean);
    if (!list.length) continue;
    const keyTag = (i) => (i ? `key ${i + 1}` : '');
    if (provider.native) {
      if (!Anthropic) continue;
      list.forEach((apiKey, i) => {
        links.push({ id: provider.id, name: i ? `${provider.label} (${keyTag(i)})` : provider.label, client: new Anthropic({ apiKey }) });
      });
      continue;
    }
    for (const model of modelsFor(provider, env)) {
      list.forEach((apiKey, i) => {
        links.push({
          id: provider.id,
          name: `${provider.label} (${[model, keyTag(i)].filter(Boolean).join(', ')})`,
          client: createOpenAICompatClient({ provider, model, apiKey, OpenAIClass }),
        });
      });
    }
  }
  return links;
}

/**
 * Try each link in order; stay with the first one that works for the rest of the session.
 * @param {Array<{name, client}>} links
 * @param {{health?: Map<string, number>, onSwitch?: (to: string, from: string, err: Error) => void, now?: () => number}} opts
 *   health remembers links that failed recently (shared across sessions) so they're skipped for a while.
 */
function createChainClient(links, { health = new Map(), onSwitch = null, now = Date.now } = {}) {
  let current = null;
  const failures = [];

  function order() {
    const fresh = links.filter((l) => !(health.get(l.name) > now()));
    const list = fresh.length ? fresh : links; // if everything failed recently, try them all again
    if (current && list.includes(current)) return [current, ...list.filter((l) => l !== current)];
    return list;
  }

  return {
    failures,
    get active() {
      return current ? current.name : null;
    },
    beta: {
      messages: {
        async create(params) {
          let lastErr = null;
          const list = order();
          for (let i = 0; i < list.length; i++) {
            const link = list[i];
            try {
              const response = await link.client.beta.messages.create(params);
              current = link;
              health.delete(link.name);
              return response;
            } catch (err) {
              lastErr = err;
              failures.push({ name: link.name, status: err && err.status, message: err && err.message });
              health.set(link.name, now() + COOL_OFF_MS);
              if (current === link) current = null;
              if (onSwitch && list[i + 1]) onSwitch(list[i + 1].name, link.name, err);
            }
          }
          throw lastErr || new Error('No AI provider is set up');
        },
      },
    },
  };
}

module.exports = {
  PROVIDERS,
  keysFromEnv,
  allKeysFromEnv,
  modelsFor,
  toOpenAIMessages,
  toOpenAITools,
  fromOpenAIResponse,
  createOpenAICompatClient,
  buildLinks,
  createChainClient,
};
