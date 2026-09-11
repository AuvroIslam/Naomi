// Naomi's companion panel: the conversation side of the experience.

const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const input = $('#input');
const avatar = $('#avatar');
const statusEl = $('#status');
const toast = $('#toast');

let prefs = { voice: true, textSize: 'large', spotlight: true, hasApiKey: false };
let state = { phase: 'home' };
let lastUserText = '';
let toastTimer = null;

const TASKS = [
  { emoji: '✉️', label: 'Send an email', goal: 'I want to send an email' },
  { emoji: '📹', label: 'Video call someone', goal: 'I want to make a video call' },
  { emoji: '📥', label: 'Find a download', goal: 'How do I find the file I just downloaded?' },
  { emoji: '🖨️', label: 'Print something', goal: 'I want to print a document' },
  { emoji: '🖼️', label: 'Save a picture', goal: 'How do I download this picture?' },
  { emoji: '📎', label: 'Attach a file', goal: 'How do I attach a file to an email?' },
];

const THINKING_LINES = {
  first: "Let me look at your screen…",
  afterStep: 'Let me see what happened…',
  answer: 'Thank you. One moment…',
};

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------- voice ----------
function pickVoice(text) {
  const voices = speechSynthesis.getVoices();
  if (/[ঀ-৿]/.test(text)) return voices.find((v) => v.lang.toLowerCase().startsWith('bn')) || null;
  return (
    voices.find((v) => /aria|jenny|zira|female/i.test(v.name) && v.lang.startsWith('en')) ||
    voices.find((v) => v.lang.startsWith('en')) ||
    null
  );
}

function speak(text) {
  if (!prefs.voice || !text || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const voice = pickVoice(text);
  if (!voice && /[ঀ-৿]/.test(text)) return; // no Bangla voice installed; stay quiet
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 0.92;
  u.pitch = 1.05;
  speechSynthesis.speak(u);
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};

// ---------- feedback toast ----------
function showToast(text, gentle = false, ms = 4000) {
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.className = gentle ? 'toast gentle' : 'toast';
  toast.hidden = false;
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

// ---------- rendering ----------
function greeting() {
  const hr = new Date().getHours();
  if (hr < 12) return 'Good morning!';
  if (hr < 17) return 'Good afternoon!';
  return 'Good evening!';
}

function youLine() {
  return lastUserText ? h('div', { class: 'you' }, `You: ${lastUserText}`) : null;
}

function stuckButton() {
  return h('button', { class: 'btn light', onclick: onStuck }, "😕 I'm stuck");
}

function againButton(text) {
  return h('button', { class: 'btn light', onclick: () => speak(text) }, '🔊 Say again');
}

const renderers = {
  home() {
    return [
      h('p', { class: 'hello' }, greeting()),
      h('h1', { class: 'title' }, 'What would you like to do today?'),
      h(
        'div',
        { class: 'tasks' },
        TASKS.map((t) =>
          h('button', { class: 'task', onclick: () => begin(t.goal) }, h('span', { class: 'emoji' }, t.emoji), t.label),
        ),
      ),
      h('p', { class: 'muted', style: 'margin-top:16px' }, 'Or tell me in your own words below. There are no wrong questions.'),
    ];
  },

  thinking(s) {
    const line =
      s.after === 'point' || s.after === 'keys'
        ? THINKING_LINES.afterStep
        : s.after === 'ask'
          ? THINKING_LINES.answer
          : THINKING_LINES.first;
    return [
      youLine(),
      h('div', { class: 'thinking' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')), h('span', { class: 'say', style: 'margin:0' }, line)),
    ];
  },

  ask(s) {
    return [
      youLine(),
      h('p', { class: 'say' }, s.question),
      s.choices && s.choices.length
        ? h('div', { class: 'choices' }, s.choices.map((c) => h('button', { class: 'btn choice', onclick: () => answer(c) }, c)))
        : h('p', { class: 'muted' }, 'Type your answer below, or press 🎤 to say it.'),
    ];
  },

  point(s) {
    const primaryLabel = {
      type: "✓ I've typed it",
      look: '✓ Okay, next',
      scroll_down: '✓ Done scrolling',
      scroll_up: '✓ Done scrolling',
    }[s.action] || '✓ I did it';
    return [
      h('div', { class: 'step-chip' }, h('span', { class: 'pip' }), `Step ${s.step}`),
      h('p', { class: 'say' }, s.say),
      s.typeText
        ? h('div', { class: 'type-card' }, h('div', { class: 'lbl' }, 'Type this:'), h('div', { class: 'txt' }, s.typeText))
        : null,
      h('button', { class: 'btn primary', id: 'btnDone', onclick: onDone }, primaryLabel),
      h('div', { class: 'row-actions' }, againButton(s.say), stuckButton()),
      h('p', { class: 'muted', style: 'margin-top:14px' }, 'Look for the orange dot on your screen.'),
    ];
  },

  keys(s) {
    const keys = [];
    s.keys.forEach((k, i) => {
      if (i) keys.push(h('span', { class: 'plus' }, '+'));
      keys.push(h('span', { class: 'key' }, k));
    });
    return [
      h('div', { class: 'step-chip' }, h('span', { class: 'pip' }), `Step ${s.step}`),
      h('p', { class: 'say' }, s.say),
      h('div', { class: 'keys' }, keys),
      h('button', { class: 'btn primary', id: 'btnDone', onclick: onDone }, '✓ I did it'),
      h('div', { class: 'row-actions' }, againButton(s.say), stuckButton()),
    ];
  },

  finish(s) {
    return [
      h(
        'div',
        { class: 'celebrate' },
        h('div', { class: 'big' }, s.success ? '🎉' : '🤗'),
        h('p', { class: 'say' }, s.say),
        h('button', { class: 'btn coral', style: 'width:100%', onclick: goHome }, 'Do something else'),
      ),
    ];
  },

  error(s) {
    return [
      h('p', { class: 'say' }, s.say || 'Something went wrong. Let\'s try again.'),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn coral', onclick: () => window.naomi.retry() }, 'Try again'),
        h('button', { class: 'btn light', onclick: goHome }, 'Start over'),
      ),
    ];
  },

  setup(s) {
    const key = h('input', { type: 'password', placeholder: 'Paste the key here (sk-ant-…)', autocomplete: 'off' });
    const save = async () => {
      if (!key.value.trim()) return key.focus();
      prefs = await window.naomi.setApiKey(key.value);
      if (s.goal) begin(s.goal);
      else goHome();
      return undefined;
    };
    key.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    return [
      h('p', { class: 'say' }, 'Before we start, Naomi needs to be switched on.'),
      h(
        'p',
        { class: 'muted' },
        s.say || 'Naomi uses Claude to see your screen. Ask a family member to paste a Claude API key here once — you won’t need to do it again.',
      ),
      h('div', { class: 'setup' }, key, h('button', { class: 'btn coral', onclick: save }, 'Switch Naomi on')),
    ];
  },
};

const STATUS = {
  home: 'Here to help',
  thinking: 'Looking at your screen…',
  ask: 'Just a quick question',
  point: 'Follow the orange dot',
  keys: 'Use your keyboard',
  finish: 'All done!',
  error: 'Oops — let’s try again',
  setup: 'Getting ready',
};

function render(s) {
  state = s;
  const render = renderers[s.phase] || renderers.home;
  view.replaceChildren(...render(s).filter(Boolean));
  // restart the fade-in so every new message gently appears
  view.style.animation = 'none';
  void view.offsetWidth;
  view.style.animation = '';
  view.scrollTop = 0;

  statusEl.textContent = STATUS[s.phase] || STATUS.home;
  const inTask = !['home', 'setup', 'finish'].includes(s.phase);
  $('#btnStop').hidden = !inTask;
  $('#btnSettings').hidden = inTask; // keep the header roomy mid-task
  avatar.classList.toggle('thinking', s.phase === 'thinking');
  avatar.classList.toggle('happy', s.phase === 'finish' && s.success);
  input.placeholder = s.phase === 'ask' ? 'Your answer…' : 'Type here…';

  if (s.phase === 'ask') speak(s.question);
  else if (['point', 'keys', 'finish', 'error'].includes(s.phase)) speak(s.say);
}

// ---------- actions ----------
function begin(goal) {
  lastUserText = goal;
  window.naomi.start(goal);
}

function answer(text) {
  lastUserText = text;
  window.naomi.reply(text);
}

function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  if (state.phase === 'home' || state.phase === 'finish' || state.phase === 'setup') begin(text);
  else answer(text);
}

function onDone() {
  window.naomi.confirm();
}

function onStuck() {
  lastUserText = "I'm stuck";
  window.naomi.stuck();
}

function goHome() {
  lastUserText = '';
  window.naomi.stop();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, input.scrollHeight)}px`;
}

// ---------- feedback from the watcher ----------
window.naomi.onFeedback((fb) => {
  if (fb.type === 'hit') {
    showToast(fb.then === 'type' ? '👍 Good! Now type.' : '👍 Good!', false, 2500);
    speak(fb.then === 'type' ? 'Good. Now type.' : 'Good.');
  } else if (fb.type === 'nudge') {
    if (fb.reason === 'typing-idle') {
      showToast("Finished typing? Press the green button.", true, 6000);
      const done = document.getElementById('btnDone');
      if (done) done.classList.add('pulse');
    } else {
      const text = 'Take your time. Look for the orange dot — it shows you where.';
      showToast(text, true, 6000);
      speak(text);
    }
  }
});

window.naomi.onState((s) => {
  toast.hidden = true;
  render(s);
});

// ---------- settings ----------
async function applyPrefs(p) {
  prefs = p;
  document.body.classList.toggle('size-xlarge', p.textSize === 'xlarge');
  $('#optVoice').checked = p.voice;
  $('#optXL').checked = p.textSize === 'xlarge';
  $('#optSpot').checked = p.spotlight;
  $('#keyState').textContent = p.keyFromEnv ? '(set from .env)' : p.hasApiKey ? '(saved ✓)' : '(not set)';
}

$('#btnSettings').addEventListener('click', () => ($('#settings').hidden = false));
$('#btnCloseSettings').addEventListener('click', () => ($('#settings').hidden = true));
$('#optVoice').addEventListener('change', async (e) => {
  applyPrefs(await window.naomi.setPrefs({ voice: e.target.checked }));
  if (!e.target.checked) speechSynthesis.cancel();
});
$('#optXL').addEventListener('change', async (e) =>
  applyPrefs(await window.naomi.setPrefs({ textSize: e.target.checked ? 'xlarge' : 'large' })),
);
$('#optSpot').addEventListener('change', async (e) => applyPrefs(await window.naomi.setPrefs({ spotlight: e.target.checked })));
$('#btnSaveKey').addEventListener('click', async () => {
  const el = $('#optKey');
  applyPrefs(await window.naomi.setApiKey(el.value));
  el.value = '';
  showToast('Saved. Naomi is ready.', false, 2500);
});

// ---------- composer + window ----------
$('#btnSend').addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener('input', autosize);
$('#btnMic').addEventListener('click', async () => {
  input.focus();
  const ok = await window.naomi.voiceType();
  showToast(ok ? '🎤 Speak now — I’m listening.' : 'Voice typing isn’t available. Please type instead.', !ok, 4000);
});
$('#btnStop').addEventListener('click', goHome);
$('#btnMin').addEventListener('click', () => window.naomi.windowAction('minimize'));
$('#btnClose').addEventListener('click', () => window.naomi.windowAction('quit'));

(async () => {
  applyPrefs(await window.naomi.getPrefs());
  render(await window.naomi.getState());
  const greetingLine = "Hello, I'm Naomi. What would you like to do today?";
  setTimeout(() => state.phase === 'home' && speak(greetingLine), 600);
})();
