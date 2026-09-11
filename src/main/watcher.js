// ActionWatcher: watches what the person does after Naomi points somewhere, and decides
// when the step is over. Inputs are global mouse/keyboard events (DIP coordinates) plus
// small screen "signatures" for detecting when the screen has changed and settled.

const { EventEmitter } = require('node:events');
const { distance } = require('./geometry');
const { signatureDiff } = require('./imageops');

const DEFAULTS = {
  pollMs: 250,
  changePollMs: 500,
  baselineDelayMs: 900,
  minSettleMs: 350,
  doubleClickSettleMs: 750,
  maxSettleMs: 3000,
  changeThreshold: 0.03,
  stableThreshold: 0.006,
  hitRadius: 70,
  idleNudgeMs: 25000,
  typingIdleNudgeMs: 6000,
  scrollIdleMs: 1200,
  keysSettleMs: 900,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// uiohook keycodes we care about (see uiohook-napi UiohookKey)
const KEY = { Enter: 28, Tab: 15, NumpadEnter: 3612 };
const MODIFIERS = new Set([29, 3613, 42, 54, 56, 3640, 3675, 3676]); // Ctrl, Shift, Alt, Meta (L/R)

class ActionWatcher extends EventEmitter {
  /**
   * @param {object} deps
   * @param {EventEmitter} deps.input emits 'mousedown' {x,y,button}, 'keydown' {keycode}, 'wheel' {} in DIP
   * @param {() => Promise<object>} deps.getSignature small screen signature (Naomi's own UI masked out)
   * @param {(pt) => boolean} deps.isNaomiPoint true when a point is on Naomi's own panel
   * @param {() => boolean} deps.isNaomiFocused true when Naomi's panel has keyboard focus
   */
  constructor({ input, getSignature, isNaomiPoint = () => false, isNaomiFocused = () => false, options = {} }) {
    super();
    this.input = input;
    this.getSignature = getSignature;
    this.isNaomiPoint = isNaomiPoint;
    this.isNaomiFocused = isNaomiFocused;
    this.opt = { ...DEFAULTS, ...options };
    this.token = 0;
    this.step = null;
    this.timers = new Set();

    this._onMouse = this._onMouse.bind(this);
    this._onKey = this._onKey.bind(this);
    this._onWheel = this._onWheel.bind(this);
    input.on('mousedown', this._onMouse);
    input.on('keydown', this._onKey);
    input.on('wheel', this._onWheel);
  }

  // step: { action, screen: {x, y} } — action from the point tool, or 'keys' for show_keys.
  watch(step) {
    this.stop();
    const token = ++this.token;
    this.step = step;
    this.settling = false;
    this.keys = 0;
    this.baseline = null;
    this._armIdleNudge();

    const detectChanges = ['click', 'double_click', 'right_click', 'keys'].includes(step.action);
    if (detectChanges) this._changeLoop(token);
  }

  stop() {
    this.token++;
    this.step = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // Person pressed "I did it" / "Okay" / "I've typed it".
  confirm() {
    if (!this.step) return;
    this._finish({ kind: this.step.action === 'type' && this.keys > 0 ? 'typed' : 'confirmed', via: 'button' });
  }

  dispose() {
    this.stop();
    this.input.off('mousedown', this._onMouse);
    this.input.off('keydown', this._onKey);
    this.input.off('wheel', this._onWheel);
  }

  _timer(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  _armIdleNudge() {
    clearTimeout(this.idleTimer);
    this.timers.delete(this.idleTimer);
    this.idleTimer = this._timer(() => {
      if (!this.step || this.settling) return;
      this.emit('nudge', { reason: 'idle' });
      this._armIdleNudge();
    }, this.opt.idleNudgeMs);
  }

  _isHit(pt) {
    return this.step && this.step.screen && distance(pt, this.step.screen) <= this.opt.hitRadius;
  }

  _onMouse(evt) {
    if (!this.step || this.settling) return;
    const pt = { x: evt.x, y: evt.y };
    if (this.isNaomiPoint(pt)) return;
    this._armIdleNudge();
    const { action } = this.step;
    const hit = this._isHit(pt);

    if (action === 'type') {
      if (this.keys > 0) return this._settle({ kind: 'typed', via: 'click', click: pt });
      if (hit) {
        this.clickedTarget = true;
        this.emit('hit', { click: pt, then: 'type' });
        return undefined;
      }
      return this._settle({ kind: 'miss', click: pt });
    }

    if (action === 'look') return this._settle({ kind: 'changed', click: pt });
    if (action === 'scroll_down' || action === 'scroll_up' || action === 'keys') return undefined;

    if (hit) this.emit('hit', { click: pt });
    const wait = action === 'double_click' ? this.opt.doubleClickSettleMs : this.opt.minSettleMs;
    return this._settle({ kind: hit ? 'hit' : 'miss', click: pt }, wait);
  }

  _onKey(evt) {
    if (!this.step || this.settling || this.isNaomiFocused()) return;
    if (MODIFIERS.has(evt.keycode)) return;
    this._armIdleNudge();
    const { action } = this.step;

    if (action === 'type') {
      const isEnter = evt.keycode === KEY.Enter || evt.keycode === KEY.NumpadEnter;
      if ((isEnter || evt.keycode === KEY.Tab) && this.keys > 0) {
        this._settle({ kind: 'typed', via: isEnter ? 'enter' : 'tab' });
        return;
      }
      this.keys++;
      clearTimeout(this.typingTimer);
      this.timers.delete(this.typingTimer);
      this.typingTimer = this._timer(() => {
        if (this.step && !this.settling) this.emit('nudge', { reason: 'typing-idle' });
      }, this.opt.typingIdleNudgeMs);
      return;
    }

    if (action === 'keys') this._settle({ kind: 'keys' }, this.opt.keysSettleMs);
  }

  _onWheel() {
    if (!this.step || this.settling) return;
    const { action } = this.step;
    if (action !== 'scroll_down' && action !== 'scroll_up') return;
    this._armIdleNudge();
    clearTimeout(this.scrollTimer);
    this.timers.delete(this.scrollTimer);
    this.scrollTimer = this._timer(() => this._settle({ kind: 'scrolled' }, 0), this.opt.scrollIdleMs);
  }

  // Poll the screen; a big enough change means the person did *something* (maybe via keyboard).
  async _changeLoop(token) {
    await sleep(this.opt.baselineDelayMs);
    if (token !== this.token) return;
    try {
      this.baseline = await this.getSignature();
    } catch {
      return;
    }
    while (token === this.token) {
      await sleep(this.opt.changePollMs);
      if (token !== this.token || this.settling) return;
      let sig;
      try {
        sig = await this.getSignature();
      } catch {
        continue;
      }
      if (token !== this.token || this.settling) return;
      if (signatureDiff(this.baseline, sig) > this.opt.changeThreshold) {
        this._settle({ kind: 'changed' }, 0);
        return;
      }
    }
  }

  // Wait until the screen stops moving (page loaded, window opened), then finish the step.
  async _settle(observation, minWait = this.opt.minSettleMs) {
    if (this.settling || !this.step) return;
    this.settling = true;
    const token = this.token;
    await sleep(minWait);
    if (token !== this.token) return;
    try {
      let prev = await this.getSignature();
      const start = Date.now();
      while (Date.now() - start < this.opt.maxSettleMs) {
        await sleep(this.opt.pollMs);
        if (token !== this.token) return;
        const cur = await this.getSignature();
        if (signatureDiff(prev, cur) < this.opt.stableThreshold) break;
        prev = cur;
      }
    } catch {
      // If we can't sample the screen, just move on.
    }
    if (token !== this.token) return;
    this._finish(observation);
  }

  _finish(observation) {
    if (!this.step) return;
    this.stop();
    this.emit('done', observation);
  }
}

module.exports = { ActionWatcher, DEFAULTS, KEY };
