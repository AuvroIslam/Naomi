// GuideSession: one goal, one conversation with Claude.
// Claude sees the screen, calls one tool per turn (ask_user / point / show_keys / finish),
// the person acts, and we send back what they did plus a fresh screenshot.

const { EventEmitter } = require('node:events');
const { SYSTEM_PROMPT, TOOLS } = require('./prompts');
const { clamp } = require('./geometry');

const DEFAULT_MODEL = 'claude-opus-5';

function imageBlock(shot) {
  return { type: 'image', source: { type: 'base64', media_type: shot.mediaType, data: shot.base64 } };
}

function classifyError(err) {
  const status = err && err.status;
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: 'I need a valid Claude API key to see your screen. Please check Settings.' };
  }
  if (status === 429 || status === 529 || (status >= 500 && status < 600)) {
    return { kind: 'busy', message: "I'm a little busy right now. Let's try again in a moment." };
  }
  if (!status) {
    return { kind: 'offline', message: "I can't reach the internet right now. Let's check the connection and try again." };
  }
  return { kind: 'unknown', message: 'Something went wrong on my side. Let\'s try that again.', detail: err.message };
}

// Turn what the person did into words for Claude. shot = the screenshot the step was based on.
function describeObservation(obs, pending, shot) {
  const target = pending && pending.input && pending.input.target ? `"${pending.input.target}"` : 'the spot you pointed at';
  const where = (pt) => {
    if (!pt || !shot || !shot.toImage) return '';
    const p = shot.toImage(pt);
    return ` at (${p.x}, ${p.y}) in screenshot pixels`;
  };
  switch (obs.kind) {
    case 'hit':
      return `The person clicked where you pointed (${target}). Here is the screen now. Check it worked, then continue.`;
    case 'miss':
      return `The person clicked somewhere else${where(obs.click)} — not on ${target}. They may be unsure. Look at the new screen, and kindly guide them from where they are now.`;
    case 'changed':
      return 'The screen changed. Here it is now. Check whether the step worked, then continue.';
    case 'typed':
      return `The person typed something and then ${obs.via === 'enter' ? 'pressed Enter' : obs.via === 'tab' ? 'pressed Tab' : obs.via === 'click' ? `clicked${where(obs.click)}` : 'said they were done'}. Check the screen to see what they typed, then continue.`;
    case 'scrolled':
      return 'The person scrolled. Here is the screen now.';
    case 'keys':
      return 'The person pressed the keys. Here is the screen now. Check whether it worked.';
    case 'confirmed':
      return 'The person pressed "I did it". Check the screen to confirm, then continue.';
    case 'stuck':
      return 'The person pressed "I\'m stuck" — they can\'t find it or don\'t understand. Look again carefully. Describe the spot differently (colour, shape, where it is on screen), point more precisely, or take a smaller step.';
    default:
      return 'Here is the screen now.';
  }
}

class GuideSession extends EventEmitter {
  constructor({ client, capture, model = DEFAULT_MODEL, effort = 'low' }) {
    super();
    this.client = client;
    this.capture = capture;
    this.model = model;
    this.effort = effort;
    this.messages = [];
    this.pending = null;
    this.busy = false;
    this.stopped = false;
    this.steps = 0;
    this.lastShot = null;
    this.failed = null;
  }

  async start(goal) {
    const shot = await this.capture();
    return this._send(
      [
        imageBlock(shot),
        {
          type: 'text',
          text: `This screenshot is ${shot.width}x${shot.height} pixels.\nWhat the person wants to do, in their words: "${goal}"`,
        },
      ],
      shot,
    );
  }

  // Free text from the person: an answer to a question, or something they say mid-step.
  reply(text) {
    const label = this.pending && this.pending.name === 'ask_user' ? 'The person answered' : 'The person said';
    return this._respond(`${label}: "${text}"`);
  }

  // What the person did in response to a point/show_keys step.
  report(observation) {
    return this._respond(describeObservation(observation, this.pending, this.pending && this.pending.shot));
  }

  retry() {
    if (!this.failed || this.busy || this.stopped) return undefined;
    const { content, shot } = this.failed;
    this.failed = null;
    return this._send(content, shot);
  }

  stop() {
    this.stopped = true;
    this.pending = null;
    this.removeAllListeners();
  }

  async _respond(text) {
    if (this.busy || this.stopped) return;
    this.busy = true; // claim the turn before the (async) capture so double-reports can't race
    let shot;
    try {
      shot = await this.capture();
    } catch (err) {
      this.busy = false;
      this.emit('error', { kind: 'unknown', message: "I couldn't see your screen just now. Let's try again." });
      return;
    }
    const content = this.pending
      ? [{ type: 'tool_result', tool_use_id: this.pending.id, content: [{ type: 'text', text }, imageBlock(shot)] }]
      : [imageBlock(shot), { type: 'text', text }];
    this.busy = false;
    return this._send(content, shot);
  }

  _params() {
    return {
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      output_config: { effort: this.effort },
      cache_control: { type: 'ephemeral' },
      messages: this.messages,
    };
  }

  async _send(content, shot) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.pending = null;
    this.lastShot = shot;
    this.messages.push({ role: 'user', content });
    this.emit('thinking');

    let response;
    try {
      response = await this.client.beta.messages.create(this._params());
    } catch (err) {
      this.messages.pop(); // keep history valid; retry() re-sends the same turn
      this.failed = { content, shot };
      this.busy = false;
      if (!this.stopped) this.emit('error', classifyError(err));
      return;
    }
    this.busy = false;
    if (this.stopped) return;

    // Append the full content unchanged (thinking blocks included) — history stays append-only.
    this.messages.push({ role: 'assistant', content: response.content });
    this._handle(response, shot);
  }

  _handle(response, shot) {
    if (response.stop_reason === 'refusal') {
      this.emit('finish', { say: "I'm sorry, I can't help with that one. Is there something else we can do?", success: false });
      return;
    }

    const tool = response.content.find((b) => b.type === 'tool_use');
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();

    if (!tool) {
      // Plain words with no tool: treat it as an open question to the person.
      this.emit('ask', { question: text || 'Could you tell me a little more?', choices: [] });
      return;
    }

    const input = tool.input || {};
    this.pending = { id: tool.id, name: tool.name, input, shot };

    switch (tool.name) {
      case 'ask_user':
        this.emit('ask', {
          question: input.question,
          choices: Array.isArray(input.choices) ? input.choices.slice(0, 4) : [],
        });
        break;
      case 'point': {
        this.steps++;
        const image = {
          x: clamp(Math.round(input.x), 0, shot.width - 1),
          y: clamp(Math.round(input.y), 0, shot.height - 1),
        };
        this.emit('point', {
          step: this.steps,
          say: input.say,
          bubble: input.bubble || 'Here',
          action: input.action,
          typeText: input.type_text || '',
          target: input.target || '',
          image,
          screen: shot.toScreen(image),
        });
        break;
      }
      case 'show_keys':
        this.steps++;
        this.emit('keys', { step: this.steps, say: input.say, keys: input.keys || [] });
        break;
      case 'finish':
        this.emit('finish', { say: input.say, success: !!input.success });
        break;
      default:
        this.emit('error', { kind: 'unknown', message: "I got a bit mixed up. Let's try that again." });
    }
  }
}

module.exports = { GuideSession, describeObservation, classifyError, DEFAULT_MODEL };
