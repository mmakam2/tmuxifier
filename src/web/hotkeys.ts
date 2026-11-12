// Remappable keyboard chords (agent switcher, voice dictation): the combo model, the closed
// validation rule set, and the per-browser stored mapping. Pure: no DOM access except the
// singleton's guarded localStorage lookup, so it is unit-tested under vitest's node environment.
//
// Every combo is Ctrl+Shift plus an optional Alt plus one key. Ctrl+Shift is implied (not stored)
// so terminal keys like Ctrl+K and Alt+letter stay free for the pane. Meta is refused because
// browsers do not report key releases while it is held, which breaks chord tracking.

export type HotkeyAction = 'switcher' | 'voice';
export interface Combo {
  alt: boolean;
  code: string;
}
export interface KeyLike {
  type: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
}
export type ComboVerdict = { ok: true; combo: Combo } | { ok: false; reason: string };

export const DEFAULT_HOTKEYS: Record<HotkeyAction, Combo> = {
  switcher: { alt: false, code: 'KeyK' },
  voice: { alt: false, code: 'Space' },
};
export const HOTKEY_LABEL: Record<HotkeyAction, string> = {
  switcher: 'Agent switcher',
  voice: 'Voice dictation (toggle)',
};
export const HOTKEYS_STORAGE_KEY = 'tmuxifier.hotkeys';

export const MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

const PUNCT: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};
const ACTIONS: HotkeyAction[] = ['switcher', 'voice'];
const CLIPBOARD = new Set(['KeyC', 'KeyV']);
const BROWSER_KEPT = new Set(['KeyT', 'KeyN', 'KeyW', 'KeyQ', 'KeyJ', 'KeyI', 'KeyB', 'KeyM', 'KeyE', 'KeyZ', 'Delete']);

const fail = (reason: string): ComboVerdict => ({ ok: false, reason });

function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code === 'Space') return 'Space';
  return PUNCT[code] ?? code;
}

export function comboLabel(c: Combo): string {
  return `Ctrl+Shift+${c.alt ? 'Alt+' : ''}${keyName(c.code)}`;
}

function allowedKey(code: string): boolean {
  return /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || code === 'Space' || Object.hasOwn(PUNCT, code);
}

export function validateCombo(c: Combo, other?: { action: HotkeyAction; combo: Combo }): ComboVerdict {
  if (!allowedKey(c.code))
    return fail('Use a letter, a digit, Space, or a punctuation key. Tab, Esc, Enter and the arrows are taken.');
  if (CLIPBOARD.has(c.code)) return fail('Ctrl+Shift+C and Ctrl+Shift+V are copy and paste in the terminal.');
  if (!c.alt && BROWSER_KEPT.has(c.code)) return fail(`Browsers keep ${comboLabel(c)} for themselves.`);
  if (other && other.combo.alt === c.alt && other.combo.code === c.code)
    return fail(`That combo is already used by ${HOTKEY_LABEL[other.action]}.`);
  return { ok: true, combo: { alt: c.alt, code: c.code } };
}

export function validateRecorded(ev: KeyLike, other: { action: HotkeyAction; combo: Combo }): ComboVerdict | null {
  if (MODIFIER_CODES.has(ev.code)) return null;
  if (ev.metaKey) return fail("Cmd/Win can't be part of a hotkey: browsers don't report key releases while it is held.");
  if (!ev.ctrlKey || !ev.shiftKey)
    return fail('Hotkeys must include Ctrl+Shift, so terminal keys like Ctrl+K and Alt+letter stay free.');
  return validateCombo({ alt: ev.altKey, code: ev.code }, other);
}

export function matchesCombo(ev: KeyLike, c: Combo): boolean {
  return ev.ctrlKey && ev.shiftKey && !ev.metaKey && ev.altKey === c.alt && ev.code === c.code;
}

export function chordCodes(c: Combo): Set<string> {
  const s = new Set([c.code, 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight']);
  if (c.alt) {
    s.add('AltLeft');
    s.add('AltRight');
  }
  return s;
}

const defaults = (): Record<HotkeyAction, Combo> => ({
  switcher: { ...DEFAULT_HOTKEYS.switcher },
  voice: { ...DEFAULT_HOTKEYS.voice },
});

export function parseStoredHotkeys(raw: string | null): Record<HotkeyAction, Combo> {
  try {
    if (!raw) return defaults();
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o) || (o as { v?: unknown }).v !== 1) return defaults();
    const out = defaults();
    for (const a of ACTIONS) {
      const c = (o as Record<string, unknown>)[a];
      if (!c || typeof c !== 'object') continue;
      const { alt, code } = c as { alt?: unknown; code?: unknown };
      if (typeof alt !== 'boolean' || typeof code !== 'string') continue;
      const v = validateCombo({ alt, code });
      if (v.ok) out[a] = v.combo;
    }
    if (out.switcher.alt === out.voice.alt && out.switcher.code === out.voice.code) return defaults();
    return out;
  } catch {
    return defaults();
  }
}

export function serializeHotkeys(m: Record<HotkeyAction, Combo>): string {
  return JSON.stringify({
    v: 1,
    switcher: { alt: m.switcher.alt, code: m.switcher.code },
    voice: { alt: m.voice.alt, code: m.voice.code },
  });
}

export interface HotkeyStore {
  get(a: HotkeyAction): Combo;
  set(a: HotkeyAction, c: Combo): ComboVerdict;
  reset(a: HotkeyAction): ComboVerdict;
  recording(): boolean;
  setRecording(on: boolean): void;
}

export function createHotkeyStore(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): HotkeyStore {
  let raw: string | null = null;
  try {
    raw = storage ? storage.getItem(HOTKEYS_STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  let map = parseStoredHotkeys(raw);
  let rec = false;
  const otherOf = (a: HotkeyAction) => {
    const action: HotkeyAction = a === 'switcher' ? 'voice' : 'switcher';
    return { action, combo: map[action] };
  };
  const apply = (a: HotkeyAction, c: Combo): ComboVerdict => {
    const v = validateCombo(c, otherOf(a));
    if (!v.ok) return v;
    map = { ...map, [a]: v.combo };
    try {
      storage?.setItem(HOTKEYS_STORAGE_KEY, serializeHotkeys(map));
    } catch {
      // storage unavailable: the mapping still holds in memory
    }
    return v;
  };
  return {
    get: (a) => ({ ...map[a] }),
    set: apply,
    reset: (a) => apply(a, DEFAULT_HOTKEYS[a]),
    recording: () => rec,
    setRecording: (on) => {
      rec = on;
    },
  };
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export const hotkeys: HotkeyStore = createHotkeyStore(browserStorage());
