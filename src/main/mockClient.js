// Offline stand-in for the Claude client (NAOMI_MOCK=1 or --mock). It plays a fixed script so
// the panel, pointer, and watcher can be exercised without an API key. Point coordinates are
// fractions of the screenshot size, resolved against the size stated in the first message.

const SCRIPT = [
  {
    name: 'ask_user',
    input: {
      question: "Do you know your granddaughter's email address?",
      choices: ['Yes, I know it', "No, I don't"],
    },
  },
  {
    name: 'point',
    input: {
      say: "Let's start writing. Click here to begin a new email.",
      bubble: 'Click here',
      action: 'click',
      fx: 0.22,
      fy: 0.33,
      type_text: '',
      target: 'the Compose button',
    },
  },
  {
    // Sits under Naomi's panel on purpose: she should scoot to the other side.
    name: 'point',
    input: {
      say: 'This is where your new email appears.',
      bubble: 'Look here',
      action: 'look',
      fx: 0.86,
      fy: 0.5,
      type_text: '',
      target: 'the new email window',
    },
  },
  {
    name: 'point',
    input: {
      say: 'Type her email address in this box.',
      bubble: 'Type here',
      action: 'type',
      fx: 0.6,
      fy: 0.42,
      type_text: 'alysa2002@gmail.com',
      target: 'the To box',
    },
  },
  { name: 'show_keys', input: { say: 'Hold Ctrl and press Enter to send it.', keys: ['Ctrl', 'Enter'] } },
  {
    name: 'finish',
    input: {
      say: 'Your email is on its way to your granddaughter. Well done!',
      success: true,
      remember: ["Granddaughter Alysa's email: alysa2002@gmail.com", 'Uses Gmail in Chrome'],
    },
  },
];

function screenshotSize(messages) {
  for (const m of messages) {
    for (const block of Array.isArray(m.content) ? m.content : []) {
      const match = block.type === 'text' && /(\d+)x(\d+) pixels/.exec(block.text);
      if (match) return { width: Number(match[1]), height: Number(match[2]) };
    }
  }
  return { width: 1280, height: 720 };
}

function resolve(step, size) {
  if (step.name !== 'point') return step.input;
  const { fx, fy, ...rest } = step.input;
  return { ...rest, x: Math.round(fx * size.width), y: Math.round(fy * size.height), from_zoom: false };
}

function createMockClient({ delayMs = 1200 } = {}) {
  let i = 0;
  return {
    naomiScripted: true, // fixed script: no aim check
    beta: {
      messages: {
        async create(params) {
          await new Promise((r) => setTimeout(r, delayMs));
          const step = SCRIPT[Math.min(i, SCRIPT.length - 1)];
          i++;
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `mock_${i}`, name: step.name, input: resolve(step, screenshotSize(params.messages)) }],
          };
        },
      },
    },
  };
}

module.exports = { createMockClient, SCRIPT };
