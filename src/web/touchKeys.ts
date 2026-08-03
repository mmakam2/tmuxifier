// Touch key bar for phone mode: the keys a soft keyboard can't type reliably
// (Esc, Tab, Shift+Tab, arrows, Ctrl) plus Enter. Pure half — sequence lookup
// and the sticky-Ctrl state machine — lives here and is unit-tested; the DOM
// builder below it is e2e-covered (vitest has no DOM by project convention).

export type TouchKey =
  | 'esc' | 'tab' | 'shift-tab' | 'up' | 'down' | 'left' | 'right' | 'enter' | 'ctrl';

export const TOUCH_KEYS: { id: TouchKey; label: string }[] = [
  { id: 'esc', label: 'esc' },
  { id: 'tab', label: '⇥' },
  { id: 'shift-tab', label: '⇤' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'left', label: '←' },
  { id: 'right', label: '→' },
  { id: 'ctrl', label: 'ctrl' },
  { id: 'enter', label: '⏎' },
];

// Arrows honor DECCKM (application cursor keys): tmux, vim and Claude Code's
// TUI switch the terminal into application mode, where arrows are ESC O x.
// The caller reads the live mode off xterm (term.modes.applicationCursorKeysMode).
const PLAIN: Record<string, string> = {
  esc: '\x1b', tab: '\t', 'shift-tab': '\x1b[Z', enter: '\r',
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
        const code = d.toUpperCase().charCodeAt(0);
        if (code >= 0x40 && code <= 0x5f) return String.fromCharCode(code & 0x1f);
      }
      return d;
    },
  };
}
