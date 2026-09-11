// Offline practice guide. It speaks the same tool protocol as Claude, but follows a gentle
// script over the Practice Mail window and adapts to what the person actually does:
// missed clicks, "I'm stuck", and windows that got closed along the way.

const STEPS = [
  {
    tool: 'ask_user',
    input: {
      question: "Let's practise sending an email to your granddaughter, Alysa. Do you know her email address?",
      choices: ['Yes', "No, I don't"],
    },
    capture: 'knows',
  },
  {
    tool: 'point',
    id: 'sent',
    say: (a) =>
      /^yes/i.test(a.knows || '')
        ? "Good. Let's check it in an old email, just to be sure. Click here to see emails you sent."
        : "That's okay — we can find it. Have you emailed her before? Let's look at emails you sent. Click here.",
    short: 'Click here to see emails you sent.',
    hint: 'It says "Sent", on the left side of the Practice Mail window.',
    bubble: 'Click here',
    action: 'click',
    target: 'the Sent folder',
  },
  {
    tool: 'point',
    id: 'row-alysa',
    say: () => 'There she is. Click her email.',
    short: 'Click the email to Alysa.',
    hint: 'It is the first line, starting with the name Alysa.',
    bubble: 'Click here',
    action: 'click',
    target: 'the email to Alysa',
  },
  {
    tool: 'point',
    id: 'addr',
    say: () => 'This is her email address. Now we know it!',
    short: 'This is her email address.',
    bubble: 'Her email address',
    action: 'look',
    target: "Alysa's email address",
  },
  {
    tool: 'point',
    id: 'compose',
    say: () => 'Now click here to write a new email.',
    short: 'Click here to write a new email.',
    hint: 'The light blue button at the top left, with a pencil.',
    bubble: 'Click here',
    action: 'click',
    target: 'the Compose button',
  },
  {
    tool: 'point',
    id: 'to',
    say: () => 'Type her email address in this box.',
    short: 'Click this box and type her address.',
    hint: 'It is the top line of the new message, next to the word "To".',
    bubble: 'Type here',
    action: 'type',
    typeText: () => 'alysa2002@gmail.com',
    target: 'the To box',
  },
  {
    tool: 'ask_user',
    input: { question: 'What would you like to say to her?', choices: [] },
    capture: 'message',
  },
  {
    tool: 'point',
    id: 'body',
    say: () => 'Lovely. Now type your message in this big box.',
    short: 'Click this big box and type your message.',
    hint: 'It is the large white space in the middle of the new message.',
    bubble: 'Type here',
    action: 'type',
    typeText: (a) => a.message || 'I love you!',
    target: 'the message box',
  },
  {
    tool: 'point',
    id: 'send',
    say: () => 'Now click Send.',
    short: 'Click Send.',
    hint: 'The dark blue button at the bottom of the new message.',
    bubble: 'Click to send',
    action: 'click',
    target: 'the Send button',
  },
  {
    tool: 'finish',
    input: {
      say: "Wonderful — you sent it! That's exactly how it works in your real email too.",
      success: true,
      remember: [],
    },
  },
];

// If a thing isn't on screen any more (say, the new message was closed), go back to the step that opens it.
const OPENED_BY = { 'row-alysa': 'sent', addr: 'row-alysa', to: 'compose', body: 'compose', send: 'compose' };

function lastUserText(messages) {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return '';
  const parts = [];
  for (const b of last.content) {
    if (b.type === 'text') parts.push(b.text);
    if (b.type === 'tool_result') for (const c of b.content || []) if (c.type === 'text') parts.push(c.text);
  }
  return parts.join(' ');
}

/**
 * @param {{locate: (id: string) => Promise<{x,y}|null>, delayMs?: number}} opts
 *   locate returns an element's center in screenshot pixels, or null if it isn't visible.
 */
function createPracticeClient({ locate, delayMs = 900 }) {
  let index = -1;
  let redo = false;
  let calls = 0;
  const answers = {};
  const indexOf = (id) => STEPS.findIndex((s) => s.id === id);

  async function build(i, prefix, depth = 0) {
    const step = STEPS[i];
    if (step.tool !== 'point') return { name: step.tool, input: step.input };

    const pt = await locate(step.id);
    if (!pt) {
      const back = OPENED_BY[step.id];
      if (back && depth < 4) {
        index = indexOf(back);
        return build(index, "Oops, that closed. That's okay — let's open it again.", depth + 1);
      }
      redo = true;
      return {
        name: 'ask_user',
        input: { question: "I can't see the Practice Mail window. Is it open on your screen?", choices: ["Yes, it's open"] },
      };
    }
    return {
      name: 'point',
      input: {
        say: prefix ? `${prefix} ${step.short}` : step.say(answers),
        bubble: step.bubble,
        action: step.action,
        x: Math.round(pt.x),
        y: Math.round(pt.y),
        from_zoom: false,
        type_text: step.typeText ? step.typeText(answers) : '',
        target: step.target,
      },
    };
  }

  function decide(text) {
    if (index < 0) {
      index = 0;
      return null;
    }
    if (redo) {
      redo = false;
      return null;
    }
    if (/somewhere else/.test(text)) return "That's okay. Let's try this one.";
    if (/I'm stuck/.test(text)) return STEPS[index].hint || 'Let me show you again.';
    if (/The person said:/.test(text)) return "Let's keep going together.";
    const answered = /The person answered: "([\s\S]*)"/.exec(text);
    if (answered && STEPS[index].capture) answers[STEPS[index].capture] = answered[1];
    index = Math.min(index + 1, STEPS.length - 1);
    return null;
  }

  return {
    naomiScripted: true, // exact coordinates: no aim check needed
    beta: {
      messages: {
        async create(params) {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          const prefix = decide(lastUserText(params.messages));
          const call = await build(index, prefix);
          calls++;
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: `practice_${calls}`, name: call.name, input: call.input }],
          };
        },
      },
    },
  };
}

module.exports = { createPracticeClient, STEPS, lastUserText };
