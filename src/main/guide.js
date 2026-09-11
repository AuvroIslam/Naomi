// GuideSession: one goal, one conversation with Claude.
// Claude sees the screen, calls one tool per turn (ask_user / point / zoom_in / show_keys / finish),
// the person acts, and we send back what they did plus a fresh screenshot.

const { EventEmitter } = require('node:events');
const { SYSTEM_PROMPT, TOOLS } = require('./prompts');
const { clamp } = require('./geometry');

const DEFAULT_MODEL = 'claude-opus-5';
const MAX_ZOOMS_IN_A_ROW = 2;

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
  return { kind: 'unknown', message: "Something went wrong on my side. Let's try that again.", detail: err.message };
}

// zoom_in gives a center + size; turn it into a top-left region inside the screenshot.
function zoomRegion(input, shot) {
  const width = clamp(Math.round(input.width || 0), 40, shot.width);
  const height = clamp(Math.round(input.height || 0), 40, shot.height);
  return {
    x: clamp(Math.round((input.x || 0) - width / 2), 0, shot.width - width),
    y: clamp(Math.round((input.y || 0) - height / 2), 0, shot.height - height),
    width,
    height,
  };
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
  /**
   * @param {object} deps
   * @param {object} deps.client Anthropic client (or a stand-in with beta.messages.create)
   * @param {() => Promise<object>} deps.capture screenshot of the whole screen
   * @param {(region, shot) => Promise<object>} [deps.zoom] magnified screenshot of a region
   * @param {string[]} [deps.memories] facts remembered from earlier sessions
   */
  constructor({ client, capture, zoom = null, memories = [], model = DEFAULT_MODEL, effort = 'low' }) {
    super();
    this.client = client;
    this.capture = capture;
    this.zoom = zoom;
    this.memories = memories;
    this.model = model;
    this.effort = effort;
    this.messages = [];
    this.pending = null;
    this.busy = false;
    this.stopped = false;
    this.compat = false;
    this.steps = 0;
    this.zoomsInARow = 0;
    this.lastZoom = null;
    this.lastShot = null;
    this.failed = null;
  }

  async start(goal) {
    const shot = await this.capture();
    const memo = this.memories.length
      ? `\n\nThings you remember about this person from earlier sessions:\n${this.memories.map((m) => `- ${m}`).join('\n')}`
      : '';
    return this._send(
      [
        imageBlock(shot),
        {
          type: 'text',
          text: `This screenshot is ${shot.width}x${shot.height} pixels.${memo}\n\nWhat the person wants to do, in their words: "${goal}"`,
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
    const params = {
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: this.messages,
    };
    if (this.compat) return params;
    return {
      ...params,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: this.effort },
      cache_control: { type: 'ephemeral' },
    };
  }

  // If the account or model rejects an optional feature (400), fall back once to the plain
  // request shape for the rest of the session rather than leaving the person stranded.
  async _create() {
    try {
      return await this.client.beta.messages.create(this._params());
    } catch (err) {
      if (err && err.status === 400 && !this.compat) {
        this.compat = true;
        return this.client.beta.messages.create(this._params());
      }
      throw err;
    }
  }

  async _send(content, shot, info = {}) {
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.pending = null;
    this.lastShot = shot;
    this.messages.push({ role: 'user', content });
    this.emit('thinking', info);

    let response;
    try {
      response = await this._create();
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
    await this._handle(response, shot);
  }

  async _handle(response, shot) {
    if (response.stop_reason === 'refusal') {
      this.emit('finish', {
        say: "I'm sorry, I can't help with that one. Is there something else we can do?",
        success: false,
        remember: [],
      });
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
    if (tool.name === 'zoom_in') {
      await this._zoomIn(input, shot);
      return;
    }
    this.zoomsInARow = 0;

    switch (tool.name) {
      case 'ask_user':
        this.emit('ask', {
          question: input.question,
          choices: Array.isArray(input.choices) ? input.choices.slice(0, 4) : [],
        });
        break;
      case 'point': {
        if (!Number.isFinite(Number(input.x)) || !Number.isFinite(Number(input.y))) {
          // Some models occasionally leave out coordinates: ask again (twice at most) rather than guess.
          this.badPoints = (this.badPoints || 0) + 1;
          if (this.badPoints > 2) {
            this.emit('error', { kind: 'unknown', message: "I got a bit mixed up. Let's try that again." });
            return;
          }
          await this._send(
            [
              {
                type: 'tool_result',
                tool_use_id: tool.id,
                is_error: true,
                content: [{ type: 'text', text: 'x and y must be whole numbers: pixel coordinates in the latest screenshot. Please call point again.' }],
              },
            ],
            shot,
          );
          return;
        }
        this.badPoints = 0;
        this.steps++;
        let x = Number(input.x);
        let y = Number(input.y);
        if (input.from_zoom && this.lastZoom) {
          const z = this.lastZoom;
          x = z.region.x + (x * z.region.width) / z.width;
          y = z.region.y + (y * z.region.height) / z.height;
        }
        this.lastZoom = null;
        const image = { x: clamp(Math.round(x), 0, shot.width - 1), y: clamp(Math.round(y), 0, shot.height - 1) };
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
      case 'finish': {
        // A "success" before the person has done anything is a misread screen, not a finished task.
        const firstTurn = this.messages.filter((m) => m.role === 'assistant').length <= 1;
        if (input.success && firstTurn && !this.finishPushedBack) {
          this.finishPushedBack = true;
          await this._send(
            [
              {
                type: 'tool_result',
                tool_use_id: tool.id,
                is_error: true,
                content: [
                  {
                    type: 'text',
                    text: "The person hasn't done anything yet, so the goal can't be finished. Look at the screen again and guide them through the first step, or ask them a question.",
                  },
                ],
              },
            ],
            shot,
          );
          return;
        }
        this.emit('finish', {
          say: input.say,
          success: !!input.success,
          remember: Array.isArray(input.remember)
            ? input.remember.filter((m) => typeof m === 'string' && m.trim()).slice(0, 5)
            : [],
        });
        break;
      }
      default:
        this.emit('error', { kind: 'unknown', message: "I got a bit mixed up. Let's try that again." });
    }
  }

  // Claude asked for a closer look: answer immediately with a magnified crop (no action needed
  // from the person), capped so it can't loop.
  async _zoomIn(input, shot) {
    this.zoomsInARow++;
    const region = zoomRegion(input, shot);
    let content;
    if (!this.zoom || this.zoomsInARow > MAX_ZOOMS_IN_A_ROW) {
      this.lastZoom = null;
      content = [{ type: 'text', text: 'Please point now, using the full screenshot.' }];
    } else {
      try {
        const z = await this.zoom(region, shot);
        this.lastZoom = { region, width: z.width, height: z.height };
        content = [
          {
            type: 'text',
            text: `Magnified view of the area at (${region.x}, ${region.y}), size ${region.width}x${region.height} in the full screenshot. This image is ${z.width}x${z.height}. To point at something here, use its x,y in this image and set from_zoom to true.`,
          },
          imageBlock(z),
        ];
      } catch {
        this.lastZoom = null;
        content = [{ type: 'text', text: "Couldn't zoom just now. Please point using the full screenshot." }];
      }
    }
    if (this.stopped) return;
    const toolUseId = this.pending.id;
    await this._send([{ type: 'tool_result', tool_use_id: toolUseId, content }], shot, { closer: true });
  }
}

module.exports = { GuideSession, describeObservation, classifyError, zoomRegion, DEFAULT_MODEL };
