// Naomi's pointer: a friendly dot that glides to the exact spot, with a speech bubble.

const pointer = document.getElementById('pointer');
const bubble = document.getElementById('bubble');
const spot = document.getElementById('spot');
const label = bubble.querySelector('.label');
const typeBox = bubble.querySelector('.type');
const confetti = document.getElementById('confetti');

let pos = null; // where the dot rests now
let visible = false;
let spotlightOn = true;
let hideTimer = null;

const ACTION_LABEL = {
  click: 'Click here',
  double_click: 'Double-click here',
  right_click: 'Right-click here',
  type: 'Type here',
  scroll_down: 'Scroll down',
  scroll_up: 'Scroll up',
  look: 'Look here',
};

function place(el, x, y) {
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function jump(x, y) {
  for (const el of [pointer, bubble, spot]) el.classList.add('no-anim');
  place(pointer, x, y);
  place(spot, x, y);
  void pointer.offsetWidth; // flush so the jump isn't animated
  for (const el of [pointer, bubble, spot]) el.classList.remove('no-anim');
}

// Keep the bubble beside the dot, flipping sides near screen edges.
function placeBubble(x, y) {
  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  let bx = x + 34;
  let by = y + 28;
  if (bx + w > innerWidth - 12) bx = x - 34 - w;
  if (by + h > innerHeight - 12) by = y - 28 - h;
  bx = Math.max(12, Math.min(innerWidth - w - 12, bx));
  by = Math.max(12, Math.min(innerHeight - h - 12, by));
  place(bubble, bx, by);
}

function setBubble(text, typeText, action) {
  label.textContent = text;
  if (action === 'scroll_down' || action === 'scroll_up') {
    const hint = document.createElement('span');
    hint.className = 'scroll-hint';
    hint.textContent = action === 'scroll_down' ? '⌄' : '⌃';
    label.append(hint);
  }
  bubble.classList.toggle('scroll-up', action === 'scroll_up');
  typeBox.textContent = typeText || '';
}

function point(msg) {
  clearTimeout(hideTimer);
  pointer.className = '';
  bubble.className = '';
  pointer.dataset.edge = msg.edge || ''; // arrow toward a target Windows keeps on top (taskbar)
  // First appearance (or "show me again"): travel out from Naomi's face to the target.
  if (!visible || !pos || msg.replay) jump(msg.from ? msg.from.x : msg.x, msg.from ? msg.from.y : msg.y);

  setBubble(msg.bubble || ACTION_LABEL[msg.action] || 'Here', msg.typeText, msg.action);
  requestAnimationFrame(() => {
    place(pointer, msg.x, msg.y);
    place(spot, msg.x, msg.y);
    placeBubble(msg.x, msg.y);
    spot.classList.toggle('on', msg.spotlight !== false && spotlightOn);
  });
  pos = { x: msg.x, y: msg.y };
  visible = true;
}

function hit(msg) {
  pointer.classList.remove('nudge');
  pointer.classList.add('hit');
  bubble.classList.add('hit');
  if (msg.then === 'type') {
    // They clicked the box: keep pointing, now ask for typing.
    label.textContent = 'Good! Now type';
    setTimeout(() => {
      pointer.classList.remove('hit');
      bubble.classList.remove('hit');
    }, 900);
  } else {
    label.textContent = 'Good!';
    typeBox.textContent = '';
    spot.classList.remove('on');
  }
  if (pos) placeBubble(pos.x, pos.y);
}

function thinking() {
  if (!visible) return;
  // Let a success animation finish before settling into the "thinking" rest.
  const delay = pointer.classList.contains('hit') ? 700 : 0;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    pointer.className = 'thinking';
    bubble.className = 'hidden';
    spot.classList.remove('on');
  }, delay);
}

function hide() {
  clearTimeout(hideTimer);
  pointer.className = 'hidden';
  bubble.className = 'hidden';
  spot.classList.remove('on');
  visible = false;
}

function nudge() {
  if (!visible) return;
  pointer.classList.remove('nudge');
  bubble.classList.remove('nudge');
  void pointer.offsetWidth;
  pointer.classList.add('nudge');
  bubble.classList.add('nudge');
  setTimeout(() => {
    pointer.classList.remove('nudge');
    bubble.classList.remove('nudge');
  }, 3000);
}

function celebrate() {
  hide();
  const colors = ['#ff6a4d', '#ffc94d', '#22b573', '#4d8bff', '#b86bff'];
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('div');
    c.className = 'confetto';
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = `${1.8 + Math.random() * 1.6}s`;
    c.style.animationDelay = `${Math.random() * 0.5}s`;
    confetti.append(c);
  }
  setTimeout(() => confetti.replaceChildren(), 4200);
}

window.overlay.on((msg) => {
  switch (msg.type) {
    case 'point':
      return point(msg);
    case 'hit':
      return hit(msg);
    case 'thinking':
      return thinking();
    case 'nudge':
      return nudge();
    case 'celebrate':
      return celebrate();
    case 'prefs':
      spotlightOn = msg.spotlight !== false;
      if (!spotlightOn) spot.classList.remove('on');
      return undefined;
    case 'hide':
    default:
      return hide();
  }
});
