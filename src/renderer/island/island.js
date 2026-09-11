// Naomi's island: a small pill at the top of the screen that grows when she needs to talk
// and shrinks back while the orange dot does the pointing.

const $ = (sel) => document.querySelector(sel);
const island = $('#island');
const content = $('#content');
const flash = $('#flash');

let prefs = { voice: true, textSize: 'large', spotlight: true, hasApiKey: false, memoryCount: 0 };
let state = { phase: 'home' };
let collapsed = false; // home shown as the small "Ask Naomi" pill
let settingsOpen = false;
let lastUserText = '';
let interactive = false;
let flashTimer = null;
let collapseTimer = null;

const TASKS = [
  { emoji: '✉️', label: 'Send an email', goal: 'I want to send an email' },
  { emoji: '📹', label: 'Video call', goal: 'I want to make a video call' },
  { emoji: '📥', label: 'Find a download', goal: 'How do I find the file I just downloaded?' },
  { emoji: '🖨️', label: 'Print something', goal: 'I want to print a document' },
  { emoji: '🖼️', label: 'Save a picture', goal: 'How do I download this picture?' },
  { emoji: '📎', label: 'Attach a file', goal: 'How do I attach a file to an email?' },
];

const WIDTH = { idle: 250, compact: 480, expanded: 560 };
const SIZE = { home: 'expanded', thinking: 'compact', ask: 'expanded', point: 'compact', keys: 'compact', finish: 'expanded', error: 'expanded', setup: 'expanded' };
const BANGLA = /[ঀ-৿]/;

// ---------- click-through: only the island itself takes the mouse ----------
function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  window.naomi.setInteractive(on);
}
document.addEventListener('mousemove', (e) => setInteractive(island.contains(e.target)));
document.addEventListener('mouseleave', () => setInteractive(false));

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

const FACE_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="f" cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#ffb199"/><stop offset=".6" stop-color="#ff6a4d"/><stop offset="1" stop-color="#e2482b"/></radialGradient></defs><circle cx="32" cy="32" r="30" fill="url(#f)"/><g class="eyes"><ellipse class="eye" cx="23" cy="28" rx="3.6" ry="4.6" fill="#1d2140"/><ellipse class="eye" cx="41" cy="28" rx="3.6" ry="4.6" fill="#1d2140"/></g><path class="mouth" d="M22 40 Q32 48 42 40" stroke="#1d2140" stroke-width="3.4" fill="none" stroke-linecap="round"/></svg>`;

function face(mood = '', big = false) {
  const el = h('div', { class: `face ${mood} ${big ? 'big' : ''}` });
  el.innerHTML = FACE_SVG; // static markup, no user content
  return el;
}

const row = (...children) => h('div', { class: 'row' }, ...children);
const iconBtn = (label, title, onclick) => h('button', { class: 'icon-btn', title, 'aria-label': title, onclick }, label);
const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick }, label);

// ---------- voice ----------
function pickVoice(text) {
  const voices = speechSynthesis.getVoices();
  if (BANGLA.test(text)) return voices.find((v) => v.lang.toLowerCase().startsWith('bn')) || null;
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
  if (!voice && BANGLA.test(text)) return;
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 0.92;
  u.pitch = 1.05;
  speechSynthesis.speak(u);
}

// ---------- pieces ----------
function greeting() {
  const hr = new Date().getHours();
  if (hr < 12) return 'Good morning!';
  if (hr < 17) return 'Good afternoon!';
  return 'Good evening!';
}

function inputRow(placeholder) {
  const input = h('input', { id: 'input', placeholder, autocomplete: 'off', spellcheck: 'false' });
  const send = () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    input.value = '';
    if (['home', 'finish', 'setup'].includes(state.phase)) begin(text);
    else answer(text);
    return undefined;
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
  const mic = h('button', { class: 'round', title: 'Speak instead of typing', 'aria-label': 'Speak', onclick: () => voiceType(input) }, '🎤');
  return h('div', { class: 'input-row' }, mic, input, h('button', { class: 'round send', title: 'Send', 'aria-label': 'Send', onclick: send }, '➜'));
}

async function voiceType(input) {
  input.focus();
  const ok = await window.naomi.voiceType();
  if (!ok) showFlash('Voice typing isn’t available. Please type instead.', true, 2500);
}

function stepLine(s) {
  return h('div', {}, h('span', { class: 'step' }, `Step ${s.step}`), s.practice ? h('span', { class: 'practice-tag' }, 'Practice') : null);
}

function stopButton() {
  return iconBtn('✕', 'Stop', goHome);
}

// ---------- screens ----------
const renderers = {
  home() {
    if (collapsed) {
      return [row(face(), h('span', { class: 'idle-text' }, 'Ask Naomi'), h('span', { class: 'idle-hint' }, 'Ctrl + Alt + N'))];
    }
    return [
      row(
        face('', true),
        h('div', { class: 'grow' }, h('div', { class: 'hello' }, `${greeting()} I'm Naomi.`), h('div', { class: 'title' }, 'What would you like to do?')),
        iconBtn('⚙', 'Settings', openSettings),
        iconBtn('–', 'Make Naomi small', collapse),
        iconBtn('×', 'Close Naomi', () => window.naomi.windowAction('quit')),
      ),
      inputRow('Tell me in your own words…'),
      h(
        'div',
        { class: 'tasks' },
        TASKS.map((t) => h('button', { class: 'task', onclick: () => begin(t.goal) }, h('span', { class: 'emoji' }, t.emoji), t.label)),
      ),
      h('p', { class: 'muted' }, 'There are no wrong questions. I’ll show you where to click with an orange dot.'),
    ];
  },

  thinking(s) {
    let line = 'Looking at your screen…';
    if (s.closer) line = 'Looking a little closer…';
    else if (s.after === 'point' || s.after === 'keys') line = 'Let me see what happened…';
    else if (s.after === 'ask') line = 'Thank you. One moment…';
    return [row(face('thinking'), h('span', { class: 'say grow' }, line), h('span', { class: 'dots' }, h('i'), h('i'), h('i')), stopButton())];
  },

  ask(s) {
    return [
      lastUserText ? h('div', { class: 'you' }, `You: ${lastUserText}`) : null,
      h('div', { class: 'row top' }, face(), h('div', { class: 'say grow' }, s.question), stopButton()),
      s.choices && s.choices.length
        ? h('div', { class: 'choices' }, s.choices.map((c) => btn(c, () => answer(c), 'choice')))
        : null,
      inputRow(s.choices && s.choices.length ? 'Or type your answer…' : 'Type your answer…'),
    ];
  },

  point(s) {
    const primary =
      { type: "✓ I've typed it", look: '✓ Okay, next', scroll_down: '✓ Done scrolling', scroll_up: '✓ Done scrolling' }[s.action] ||
      '✓ I did it';
    return [
      h('div', { class: 'row top' }, face(), h('div', { class: 'grow' }, stepLine(s), h('div', { class: 'say' }, s.say)), stopButton()),
      s.typeText ? h('div', {}, h('div', { class: 'type-label' }, 'Type this:'), h('div', { class: 'type-chip' }, s.typeText)) : null,
      h(
        'div',
        { class: 'actions' },
        btn(primary, () => window.naomi.confirm(), 'primary small'),
        btn('🔁 Show me again', () => {
          speak(s.say);
          window.naomi.replay();
        }, 'small'),
        btn("😕 I'm stuck", onStuck, 'small'),
      ),
    ];
  },

  keys(s) {
    const keys = [];
    s.keys.forEach((k, i) => {
      if (i) keys.push(h('span', { class: 'plus' }, '+'));
      keys.push(h('span', { class: 'key' }, k));
    });
    return [
      h('div', { class: 'row top' }, face(), h('div', { class: 'grow' }, stepLine(s), h('div', { class: 'say' }, s.say)), stopButton()),
      h('div', { class: 'keys' }, keys),
      h(
        'div',
        { class: 'actions' },
        btn('✓ I did it', () => window.naomi.confirm(), 'primary small'),
        btn('🔊 Say again', () => speak(s.say), 'small'),
        btn("😕 I'm stuck", onStuck, 'small'),
      ),
    ];
  },

  finish(s) {
    return [
      h('div', { class: 'row top' }, face(s.success ? 'happy' : '', true), h('div', { class: 'say grow' }, `${s.success ? '🎉 ' : ''}${s.say}`)),
      s.remembered && s.remembered.length
        ? h('div', { class: 'memo' }, "📝 I'll remember for next time:", h('ul', {}, s.remembered.map((m) => h('li', {}, m))))
        : null,
      h('div', { class: 'actions' }, btn(s.practice ? 'Now try something real' : 'Do something else', goHome, 'coral')),
    ];
  },

  error(s) {
    return [
      h('div', { class: 'row top' }, face(), h('div', { class: 'say grow' }, s.say || "Something went wrong. Let's try again.")),
      h('div', { class: 'actions' }, btn('Try again', () => window.naomi.retry(), 'coral'), btn('Start over', goHome)),
    ];
  },

  setup(s) {
    const key = h('input', { type: 'password', placeholder: 'Paste a Claude API key (sk-ant-…)', autocomplete: 'off' });
    const save = async () => {
      if (!key.value.trim()) return key.focus();
      applyPrefs(await window.naomi.setApiKey(key.value));
      if (s.goal) begin(s.goal);
      else goHome();
      return undefined;
    };
    key.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    return [
      h('div', { class: 'row top' }, face('', true), h('div', { class: 'grow' }, h('div', { class: 'say' }, 'Naomi needs to be switched on first.'), h('div', { class: 'muted', style: 'margin:4px 0 0' }, s.say || 'A family member can paste a Claude API key here once.')), stopButton()),
      h('div', { class: 'input-row settings' }, key, btn('Switch on', save, 'coral')),
      h('p', { class: 'muted' }, 'No key yet? ', h('a', { href: '#', style: 'color:#ff9f8a', onclick: (e) => { e.preventDefault(); window.naomi.practice(); } }, 'Try a safe practice run instead.')),
    ];
  },
};

function renderSettings() {
  const toggle = (label, checked, onchange) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = checked;
    box.addEventListener('change', () => onchange(box.checked));
    return h('label', { class: 'row-opt' }, h('span', {}, label), box);
  };
  const key = h('input', { type: 'password', placeholder: prefs.keyFromEnv ? 'Set from .env' : prefs.hasApiKey ? 'Saved ✓ — paste to replace' : 'sk-ant-…', autocomplete: 'off' });
  return [
    row(face(), h('div', { class: 'title grow' }, 'Settings'), iconBtn('✕', 'Close settings', closeSettings)),
    h(
      'div',
      { class: 'settings' },
      toggle('Read messages out loud', prefs.voice, async (v) => applyPrefs(await window.naomi.setPrefs({ voice: v }))),
      toggle('Extra large text', prefs.textSize === 'xlarge', async (v) => applyPrefs(await window.naomi.setPrefs({ textSize: v ? 'xlarge' : 'large' }))),
      toggle('Dim the screen around the dot', prefs.spotlight, async (v) => applyPrefs(await window.naomi.setPrefs({ spotlight: v }))),
      h(
        'div',
        { class: 'row-opt' },
        h('span', {}, `Naomi remembers ${prefs.memoryCount || 0} things`),
        btn('Forget all', async () => {
          applyPrefs(await window.naomi.clearMemory());
          render(state);
        }, 'small'),
      ),
      h(
        'div',
        { class: 'row-opt' },
        key,
        btn('Save key', async () => {
          applyPrefs(await window.naomi.setApiKey(key.value));
          render(state);
        }, 'small coral'),
      ),
    ),
    h('p', { class: 'muted' }, 'Press Ctrl + Alt + N any time to bring Naomi back.'),
  ];
}

// ---------- layout: morph the island to fit what it's showing ----------
function morph(kind) {
  const width = Math.min(WIDTH[kind], window.innerWidth - 24);
  content.style.width = `${width}px`;
  const height = Math.min(content.scrollHeight, window.innerHeight - 24);
  island.style.width = `${width}px`;
  island.style.height = `${height}px`;
  const bottom = document.body.classList.contains('bottom');
  // Tell Naomi's brain where the island will be, so she never points underneath it.
  window.naomi.reportRect({
    x: Math.round((window.innerWidth - width) / 2),
    y: bottom ? Math.round(window.innerHeight - 10 - height) : 10,
    width: Math.round(width),
    height: Math.round(height),
  });
}

function render(s) {
  state = s;
  clearTimeout(collapseTimer);
  const kind = settingsOpen ? 'expanded' : s.phase === 'home' && collapsed ? 'idle' : SIZE[s.phase] || 'expanded';
  const nodes = (settingsOpen ? renderSettings() : (renderers[s.phase] || renderers.home)(s)).filter(Boolean);
  content.replaceChildren(...nodes);
  content.classList.remove('fade');
  void content.offsetWidth;
  content.classList.add('fade');
  island.className = `island ${kind}${['point', 'keys'].includes(s.phase) ? ' pointing' : ''}`;
  morph(kind);

  if (settingsOpen) return;
  if (s.phase === 'ask') speak(s.question);
  else if (['point', 'keys', 'finish', 'error'].includes(s.phase)) speak(s.say);
  if (s.phase === 'finish') {
    window.naomi.getPrefs().then(applyPrefs);
    // Get out of the way after a moment of celebration.
    collapseTimer = setTimeout(() => {
      if (state.phase === 'finish' && !interactive) goHome(true);
    }, 12000);
  }
}

function showFlash(text, gentle = false, ms = 1400) {
  clearTimeout(flashTimer);
  flash.textContent = text;
  flash.className = gentle ? 'flash gentle' : 'flash';
  flash.hidden = false;
  flashTimer = setTimeout(() => (flash.hidden = true), ms);
}

// ---------- actions ----------
function begin(goal) {
  lastUserText = goal;
  collapsed = false;
  window.naomi.start(goal);
}

function answer(text) {
  lastUserText = text;
  window.naomi.reply(text);
}

function onStuck() {
  lastUserText = "I'm stuck";
  window.naomi.stuck();
}

function goHome(small = false) {
  lastUserText = '';
  collapsed = small;
  window.naomi.stop();
}

function collapse() {
  collapsed = true;
  settingsOpen = false;
  render(state);
}

function expand() {
  collapsed = false;
  render(state);
  const input = document.getElementById('input');
  if (input) input.focus();
}

function openSettings() {
  settingsOpen = true;
  render(state);
}

function closeSettings() {
  settingsOpen = false;
  render(state);
}

island.addEventListener('click', () => {
  if (state.phase === 'home' && collapsed) expand();
});

// ---------- messages from Naomi's brain ----------
window.naomi.onState((s) => {
  flash.hidden = true;
  if (s.phase !== 'home') settingsOpen = false;
  render(s);
});

window.naomi.onFeedback((fb) => {
  if (fb.type === 'hit') {
    island.classList.add('good');
    setTimeout(() => island.classList.remove('good'), 1200);
    showFlash(fb.then === 'type' ? '👍 Good! Now type.' : '👍 Good!');
    speak(fb.then === 'type' ? 'Good. Now type.' : 'Good.');
  } else if (fb.type === 'nudge') {
    island.classList.remove('shake');
    void island.offsetWidth;
    island.classList.add('shake');
    if (fb.reason === 'typing-idle') {
      showFlash('Finished typing? Press the green button.', true, 3500);
      const done = content.querySelector('.btn.primary');
      if (done) done.classList.add('pulse');
    } else {
      const text = 'Take your time. The orange dot shows you where.';
      showFlash(text, true, 3500);
      speak(text);
    }
  }
});

window.naomi.onDock((side) => {
  document.body.classList.toggle('bottom', side === 'bottom');
  render(state);
});

window.naomi.onSummon(() => {
  if (state.phase === 'home') expand();
});

// ---------- settings ----------
function applyPrefs(p) {
  prefs = p;
  document.body.classList.toggle('xl', prefs.textSize === 'xlarge');
}

(async () => {
  applyPrefs(await window.naomi.getPrefs());
  render(await window.naomi.getState());
  setTimeout(() => state.phase === 'home' && !collapsed && speak("Hello, I'm Naomi. What would you like to do today?"), 700);
})();
