// Touch key bar for phone mode: the keys a soft keyboard can't type reliably
// (Esc, Tab, Shift+Tab, arrows, Ctrl) plus Enter. Pure half — sequence lookup
// and the sticky-Ctrl state machine — lives here and is unit-tested; the DOM
// builder below it is e2e-covered (vitest has no DOM by project convention).

export type TouchKey =
  | 'esc' | 'ctrl-c' | 'tab' | 'shift-tab' | 'up' | 'down' | 'left' | 'right' | 'enter' | 'ctrl';

export const TOUCH_KEYS: { id: TouchKey; label: string; pinned?: true }[] = [
  { id: 'esc', label: 'esc' },
  // Dedicated ^C beside esc — the two Claude Code interrupts. Sticky Ctrl
  // cannot cover this on a composing soft keyboard: an IME buffers letters
  // into a word and commits them as a multi-character chunk, which the
  // transform deliberately passes through, so armed-ctrl-then-tap-c types a
  // plain c. A cap that sends ETX itself owes the IME nothing.
  { id: 'ctrl-c', label: '^C' },
  { id: 'tab', label: '⇥' },
  { id: 'shift-tab', label: '⇤' },
  // No arrow caps, for now (2026-08-04, Z Fold cover-screen feedback): caps
  // fire on pointerdown, so a horizontal scroll BEGUN on a cap sends that
  // cap's key — and the arrows were what made the strip overflow narrow
  // screens in the first place. Without them everything fits and the strip
  // never scrolls. Arrows stay in seqFor/PLAIN/APP so restoring them is one
  // catalog line each; drag-to-scroll already covers arrow needs at a prompt
  // (the wheel fallback), and long-press-click covers TUI option picking.
  { id: 'ctrl', label: 'ctrl' },
  // Pinned outside the scroller (a direct child of the bar, like the mic):
  // ⏎ is the most-used cap — submitting to Claude, confirming prompts — and
  // as the LAST item of a ~450px strip it sat past the right edge of every
  // phone viewport, reachable only by a swipe nothing advertises.
  { id: 'enter', label: '⏎', pinned: true },
];

// Arrows honor DECCKM (application cursor keys): tmux, vim and Claude Code's
// TUI switch the terminal into application mode, where arrows are ESC O x.
// The caller reads the live mode off xterm (term.modes.applicationCursorKeysMode).
const PLAIN: Record<string, string> = {
  esc: '\x1b', 'ctrl-c': '\x03', tab: '\t', 'shift-tab': '\x1b[Z', enter: '\r',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
};
const APP: Record<string, string> = {
  up: '\x1bOA', down: '\x1bOB', right: '\x1bOC', left: '\x1bOD',
};

export function seqFor(key: TouchKey, appCursor: boolean): string | null {
  if (key === 'ctrl') return null; // modifier — handled by createStickyCtrl
  if (appCursor && APP[key]) return APP[key];
  return PLAIN[key] ?? null;
}

// Sticky Ctrl: tapping the bar's ctrl key arms; the next single character —
// from the soft keyboard or wherever — is sent as its control byte, then the
// modifier disarms. Anything unmaskable (multi-byte IME bursts, escape
// sequences) passes through untouched but still disarms, so the modifier can
// never silently corrupt later input.
export function createStickyCtrl(): {
  readonly armed: boolean; arm(): void; disarm(): void; transform(d: string): string;
} {
  let armed = false;
  return {
    get armed() { return armed; },
    arm() { armed = true; },
    disarm() { armed = false; },
    transform(d: string): string {
      if (!armed) return d;
      armed = false;
      if (d === ' ') return '\x00'; // Ctrl+Space
      if (d.length === 1) {
        // Raw a–z fold, never toUpperCase(): 'ß'.toUpperCase() is 'SS', whose
        // first code unit is 'S' — masking it would send \x13 (XOFF) and freeze
        // the pane. 'ı' and 'ſ' fold to 'I'/'S' the same way. Only ASCII is
        // maskable, so only ASCII is folded.
        let code = d.charCodeAt(0);
        if (code >= 0x61 && code <= 0x7a) code -= 0x20; // a–z → A–Z
        if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
      }
      return d;
    },
  };
}

// DOM half. pointerdown + preventDefault is load-bearing: a normal click would
// move focus off xterm's hidden textarea and close the soft keyboard on every
// key press. e2e-covered (vitest has no DOM).
export function buildTouchKeyBar(
  mount: HTMLElement,
  deps: { send(d: string): void; appCursor(): boolean; sticky: ReturnType<typeof createStickyCtrl> },
): { micSlot: HTMLElement; syncCap: () => void } {
  let ctrlBtn: HTMLButtonElement | null = null;
  const paint = () => {
    ctrlBtn?.classList.toggle('armed', deps.sticky.armed);
    ctrlBtn?.setAttribute('aria-pressed', String(deps.sticky.armed));
  };
  // The split is load-bearing: the caps scroll, the pinned tail (⏎, mic) does
  // not. The cap strip is a constant ~450px, so with the scroller on the bar
  // itself the mic sat at x 442-486 — past the right edge of every phone
  // viewport (360/390/430), reachable only by a horizontal swipe nothing
  // advertises. A cap clipped inside the scroller is fine; ⏎ and the mic are not.
  const caps = document.createElement('div');
  caps.className = 'touch-caps';
  mount.appendChild(caps); // before the loop: a pinned cap appended to `mount` mid-loop must land AFTER the strip
  for (const k of TOUCH_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = k.label;
    b.setAttribute('aria-label', k.id);
    if (k.id === 'ctrl') { ctrlBtn = b; b.setAttribute('aria-pressed', 'false'); }
    const fire = () => {
      if (k.id === 'ctrl') {
        if (deps.sticky.armed) deps.sticky.disarm(); else deps.sticky.arm();
        paint();
        return;
      }
      if (deps.sticky.armed) { deps.sticky.disarm(); paint(); } // bar keys are never ctrl-modified
      const seq = seqFor(k.id, deps.appCursor());
      if (seq) deps.send(seq);
    };
    b.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); // keep focus (and the soft keyboard) on the terminal
      fire();
    });
    // Keyboard/AT path. preventDefault() above suppresses the click a pointer
    // gesture would otherwise synthesize, so these caps were dead to Enter,
    // Space and to any assistive technology that activates a control rather
    // than pointing at it. `detail === 0` is the discriminator: a real pointer
    // click carries its click count, a keyboard- or AT-synthesized one carries
    // 0 — so this adds the missing path without touching the focus-retention
    // one, and can never double-fire a tap.
    b.addEventListener('click', (ev) => { if (ev.detail === 0) fire(); });
    (k.pinned ? mount : caps).appendChild(b);
  }
  const micSlot = document.createElement('span');
  micSlot.className = 'touch-mic-slot';
  mount.appendChild(micSlot); // outside the scroller — always on screen
  // A fresh bar must render the modifier's TRUE state, not an assumed-idle one:
  // `stickyCtrl` is module-level in main.ts and outlives the bar, so arming it
  // and then logging out (or any other path that rebuilds #app) would otherwise
  // seat a new, unlit cap over a still-armed modifier — and the first character
  // typed after that would be masked silently. main.ts disarms on teardown too;
  // this is the second, local layer, and it costs one class toggle.
  paint();
  // The soft keyboard's own input flows through transformInput → sticky.transform,
  // which disarms on use — with no pointer event on this bar to notice it, so the
  // cap would stay lit over a spent modifier and the next tap would send a plain
  // character. `syncCap` is the repaint seam the input path calls instead.
  return { micSlot, syncCap: paint };
}
