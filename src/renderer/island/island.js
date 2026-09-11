// Naomi's island: a quiet glass pill at the top of the screen. It grows when Naomi needs to talk
// and settles back while the orange pointer does the showing.

const $ = (sel) => document.querySelector(sel);
const island = $('#island');
const content = $('#content');
const flash = $('#flash');

let prefs = { voice: true, textSize: 'large', spotlight: true, hasApiKey: false, memoryCount: 0, keys: {} };
let state = { phase: 'home' };
let collapsed = false; // home shown as the small "Ask Naomi" pill
let settingsOpen = false;
let lastUserText = '';
let interactive = false;
let flashTimer = null;
let collapseTimer = null;

const TASKS = [
  { label: 'Send an email', goal: 'I want to send an email' },
  { label: 'Make a video call', goal: 'I want to make a video call' },
  { label: 'Find a download', goal: 'How do I find the file I just downloaded?' },
  { label: 'Print something', goal: 'I want to print a document' },
  { label: 'Save a picture', goal: 'How do I download this picture?' },
  { label: 'Attach a file', goal: 'How do I attach a file to an email?' },
];

// In the order Naomi tries them (keys come from the app's own setup, never from the person).
const AI_LABELS = { openai: 'OpenAI', deepseek: 'DeepSeek', google: 'Gemini', anthropic: 'Claude' };

const WIDTH = { idle: 232, compact: 460, expanded: 540 };
const SIZE = { home: 'expanded', thinking: 'compact', ask: 'expanded', point: 'compact', keys: 'compact', finish: 'expanded', error: 'expanded', setup: 'expanded' };
const BANGLA = /[ঀ-৿]/;
// Naomi's look is plain type — strip any emoji an AI slips into its words.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const clean = (text) => String(text || '').replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();

// ---------- hover tracking ----------
// The main process polls the cursor to decide click-through; the page also tells it the moment
// the mouse moves onto the island, so even a quick click lands on Naomi. We also remember whether
// the person is hovering (so we don't auto-collapse under their mouse).
let lastHoverPing = 0;
document.addEventListener('mousemove', (e) => {
  interactive = island.contains(e.target);
  if (interactive && Date.now() - lastHoverPing > 40) {
    lastHoverPing = Date.now();
    window.naomi.hoverPill();
  }
});
document.addEventListener('mouseleave', () => (interactive = false));

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

const orb = (mood = '', big = false) => h('div', { class: `orb ${mood} ${big ? 'big' : ''}`, 'aria-hidden': 'true' });
const row = (...children) => h('div', { class: 'row' }, ...children);
const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick }, label);

// ---------- voice: Naomi always speaks with a woman's voice ----------
const FEMALE = /zira|aria|jenny|hazel|susan|eva\b|linda|heera|catherine|hedda|helena|sabina|michelle|emma|sonia|libby|clara|natasha|samantha|karen|moira|tessa|fiona|victoria|female|woman/i;
let voices = [];
let pendingSpeech = null;

// Voices load a moment after start; anything said before then waits instead of using the default
// (on Windows the default can be a man's voice).
function loadVoices() {
  voices = speechSynthesis.getVoices();
  if (voices.length && pendingSpeech) {
    const text = pendingSpeech;
    pendingSpeech = null;
    speak(text);
  }
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice(text) {
  const lang = BANGLA.test(text) ? 'bn' : 'en';
  const female = voices.filter((v) => FEMALE.test(v.name));
  return female.find((v) => v.lang.toLowerCase().startsWith(lang)) || (lang === 'en' ? female[0] : null) || null;
}

function speak(raw) {
  const text = clean(raw);
  if (!prefs.voice || !text || !('speechSynthesis' in window)) return;
  if (!voices.length) {
    pendingSpeech = text;
    return;
  }
  speechSynthesis.cancel();
  const voice = pickVoice(text);
  if (!voice) return; // never fall back to a man's voice
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 0.92;
  u.pitch = 1.05;
  speechSynthesis.speak(u);
}

// ---------- pieces ----------
function greeting() {
  const hr = new Date().getHours();
  if (hr < 12) return 'Good morning';
  if (hr < 17) return 'Good afternoon';
  return 'Good evening';
}

function inputRow(placeholder, submitLabel = 'Ask') {
  const input = h('input', { id: 'input', class: 'field', placeholder, autocomplete: 'off', spellcheck: 'false' });
  const send = () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    input.value = '';
    if (['home', 'finish', 'setup'].includes(state.phase)) begin(text);
    else answer(text);
    return undefined;
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
  return h('div', { class: 'input-row' }, input, btn('Speak', () => voiceType(input), 'quiet'), btn(submitLabel, send, 'primary'));
}

async function voiceType(input) {
  input.focus();
  const ok = await window.naomi.voiceType();
  if (!ok) showFlash('Voice typing isn’t available here', 'gentle', 2400);
}

function stopButton() {
  return btn('Stop', () => goHome(), 'quiet');
}

function stepLabel(s) {
  return h('div', { class: 'step' }, `Step ${s.step}${s.practice ? ' · Practice' : ''}`);
}

function connectedAIs() {
  return Object.keys(AI_LABELS)
    .filter((id) => prefs.keys && prefs.keys[id])
    .map((id) => AI_LABELS[id]);
}

// ---------- screens ----------
const renderers = {
  home() {
    if (collapsed) {
      return [row(orb(), h('span', { class: 'idle-text' }, 'Ask Naomi'), h('span', { class: 'idle-hint' }, 'Ctrl Alt N'))];
    }
    return [
      h(
        'div',
        { class: 'row top' },
        orb('', true),
        h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, `${greeting()}. I’m Naomi.`), h('div', { class: 'title' }, 'What would you like to do?')),
        h(
          'div',
          { class: 'header-actions' },
          btn('Settings', openSettings, 'quiet'),
          btn('Hide', collapse, 'quiet'),
          btn('Quit Naomi', () => window.naomi.windowAction('quit'), 'quiet danger'),
        ),
      ),
      inputRow('Tell me in your own words'),
      h('div', { class: 'tasks' }, TASKS.map((t) => h('button', { class: 'task', onclick: () => begin(t.goal) }, t.label))),
      h('p', { class: 'caption' }, 'There are no wrong questions. Naomi shows you exactly where to click.'),
    ];
  },

  thinking(s) {
    let line = 'Looking at your screen…';
    if (s.closer) line = 'Looking a little closer…';
    else if (s.after === 'point' || s.after === 'keys') line = 'Checking what happened…';
    else if (s.after === 'ask') line = 'One moment…';
    return [row(orb('thinking'), h('span', { class: 'say grow' }, line), stopButton())];
  },

  ask(s) {
    const choices = (s.choices || []).map(clean).filter(Boolean);
    return [
      h(
        'div',
        { class: 'row top' },
        orb(),
        h('div', { class: 'grow' }, lastUserText ? h('div', { class: 'eyebrow' }, lastUserText) : null, h('div', { class: 'say' }, clean(s.question))),
        stopButton(),
      ),
      choices.length ? h('div', { class: 'choices' }, choices.map((c) => btn(c, () => answer(c)))) : null,
      inputRow(choices.length ? 'Or type your answer' : 'Type your answer', 'Reply'),
    ];
  },

  point(s) {
    const primary = { type: 'I’ve typed it', look: 'Next', scroll_down: 'Done', scroll_up: 'Done' }[s.action] || 'Done';
    return [
      h('div', { class: 'row top' }, orb(), h('div', { class: 'grow' }, stepLabel(s), h('div', { class: 'say' }, clean(s.say))), stopButton()),
      s.typeText ? h('div', { class: 'type-block' }, h('span', { class: 'eyebrow' }, 'Type'), h('span', { class: 'type-chip' }, s.typeText)) : null,
      h(
        'div',
        { class: 'actions' },
        btn(primary, () => window.naomi.confirm(), 'primary'),
        btn('Show again', () => {
          speak(s.say);
          window.naomi.replay();
        }),
        btn('I’m stuck', onStuck),
      ),
    ];
  },

  keys(s) {
    const keys = [];
    s.keys.forEach((k, i) => {
      if (i) keys.push(h('span', { class: 'plus' }, '+'));
      keys.push(h('span', { class: 'key' }, clean(k)));
    });
    return [
      h('div', { class: 'row top' }, orb(), h('div', { class: 'grow' }, stepLabel(s), h('div', { class: 'say' }, clean(s.say))), stopButton()),
      h('div', { class: 'keys' }, keys),
      h('div', { class: 'actions' }, btn('Done', () => window.naomi.confirm(), 'primary'), btn('Repeat', () => speak(s.say)), btn('I’m stuck', onStuck)),
    ];
  },

  finish(s) {
    const remembered = (s.remembered || []).map(clean).filter(Boolean);
    return [
      h(
        'div',
        { class: 'row top' },
        orb(s.success ? 'happy' : '', true),
        h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, s.success ? 'All done' : 'Not this time'), h('div', { class: 'say' }, clean(s.say))),
      ),
      remembered.length
        ? h('div', { class: 'memo' }, h('div', { class: 'eyebrow' }, 'Remembered for next time'), h('ul', {}, remembered.map((m) => h('li', {}, m))))
        : null,
      h('div', { class: 'actions' }, btn(s.practice ? 'Try something real' : 'Close', () => goHome(!s.practice), 'primary')),
    ];
  },

  error(s) {
    return [
      h('div', { class: 'row top' }, orb(), h('div', { class: 'say grow' }, clean(s.say) || 'Something went wrong.')),
      h('div', { class: 'actions' }, btn('Try again', () => window.naomi.retry(), 'primary'), btn('Start over', () => goHome())),
    ];
  },

  // Naomi's AI isn't reachable (not configured, or every provider failed). Never ask for keys.
  setup(s) {
    return [
      h(
        'div',
        { class: 'row top' },
        orb('', true),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'say' }, 'I can’t reach my helper right now.'),
          h('div', { class: 'body' }, 'Check the internet connection, or ask whoever set up Naomi. You can still practise safely.'),
        ),
        stopButton(),
      ),
      h(
        'div',
        { class: 'actions' },
        btn('Try again', () => (s.goal ? begin(s.goal) : goHome()), 'primary'),
        btn('Practise safely', () => window.naomi.practice()),
      ),
    ];
  },
};

function renderSettings() {
  const toggle = (label, checked, onchange) => {
    const box = h('input', { type: 'checkbox', class: 'switch' });
    box.checked = checked;
    box.addEventListener('change', () => onchange(box.checked));
    return h('label', { class: 'opt' }, h('span', {}, label), box);
  };
  const ais = connectedAIs();
  const count = prefs.memoryCount || 0;
  return [
    row(h('div', { class: 'title grow' }, 'Settings'), btn('Close', closeSettings, 'quiet')),
    h(
      'div',
      { class: 'group' },
      toggle('Read messages aloud', prefs.voice, async (v) => applyPrefs(await window.naomi.setPrefs({ voice: v }))),
      toggle('Larger text', prefs.textSize === 'xlarge', async (v) => applyPrefs(await window.naomi.setPrefs({ textSize: v ? 'xlarge' : 'large' }))),
      toggle('Dim around the pointer', prefs.spotlight, async (v) => applyPrefs(await window.naomi.setPrefs({ spotlight: v }))),
    ),
    h(
      'div',
      { class: 'group' },
      h(
        'div',
        { class: 'opt' },
        h('span', {}, `Remembers ${count} ${count === 1 ? 'thing' : 'things'}`),
        btn('Forget', async () => {
          applyPrefs(await window.naomi.clearMemory());
          render(state);
        }, 'quiet'),
      ),
      h('div', { class: 'opt' }, h('span', {}, 'AI'), h('span', { class: 'value' }, ais.length ? ais.join(', ') : 'Not set up')),
    ),
    h(
      'div',
      { class: 'row spread' },
      h('span', { class: 'caption', style: 'margin:0' }, 'Ctrl + Alt + N brings Naomi back'),
      btn('Quit Naomi', () => window.naomi.windowAction('quit'), 'quiet danger'),
    ),
  ];
}

// ---------- layout: morph the island to fit what it's showing ----------
function morph(kind) {
  const width = Math.min(WIDTH[kind], window.innerWidth - 24);
  const maxHeight = window.innerHeight - 24;
  content.style.width = `${width}px`;
  content.style.maxHeight = `${maxHeight}px`;
  const height = Math.min(content.scrollHeight, maxHeight);
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
    // Get out of the way after a moment.
    collapseTimer = setTimeout(() => {
      if (state.phase === 'finish' && !interactive) goHome(true);
    }, 12000);
  }
}

function showFlash(text, tone = 'good', ms = 1400) {
  clearTimeout(flashTimer);
  // Naomi smiles when you get it right.
  flash.replaceChildren(orb(tone === 'good' ? 'happy' : ''), h('span', {}, text));
  flash.className = `flash ${tone}`;
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
  lastUserText = 'I’m stuck';
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

island.addEventListener('click', (e) => {
  // Clicking the small pill opens it. Clicks on buttons are ignored: "Hide" collapses the island
  // and its click then bubbles here, which would open it straight back up.
  if (e.target.closest('button')) return;
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
    showFlash(fb.then === 'type' ? 'Good. Now type.' : 'Good', 'good');
    speak(fb.then === 'type' ? 'Good. Now type.' : 'Good.');
  } else if (fb.type === 'provider') {
    showFlash('One moment…', 'gentle', 1800);
  } else if (fb.type === 'nudge') {
    island.classList.remove('shake');
    void island.offsetWidth;
    island.classList.add('shake');
    if (fb.reason === 'typing-idle') {
      showFlash('Finished typing? Press “I’ve typed it”.', 'gentle', 3500);
      const done = content.querySelector('.btn.primary');
      if (done) done.classList.add('pulse');
    } else {
      const text = 'Take your time. Follow the orange dot.';
      showFlash(text, 'gentle', 3500);
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
  setTimeout(() => state.phase === 'home' && !collapsed && speak('Hello, I’m Naomi. What would you like to do today?'), 700);
})();
