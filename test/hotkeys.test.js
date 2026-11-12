import { describe, test, expect } from 'vitest';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_LABEL,
  HOTKEYS_STORAGE_KEY,
  MODIFIER_CODES,
  validateCombo,
  validateRecorded,
  matchesCombo,
  chordCodes,
  comboLabel,
  parseStoredHotkeys,
  serializeHotkeys,
  createHotkeyStore,
  hotkeys,
} from '../src/web/hotkeys.ts';

const ev = (o = {}) => ({
  type: 'keydown',
  code: 'KeyK',
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  ...o,
});
const voice = { action: 'voice', combo: DEFAULT_HOTKEYS.voice };
const D = DEFAULT_HOTKEYS;

function fakeStorage(initial = null) {
  const s = { v: initial, getItem: () => s.v, setItem: (_k, val) => { s.v = val; } };
  return s;
}

describe('hotkeys', () => {
  test('constants', () => {
    expect(D.switcher).toEqual({ alt: false, code: 'KeyK' });
    expect(D.voice).toEqual({ alt: false, code: 'Space' });
    expect(HOTKEY_LABEL.switcher).toBe('Agent switcher');
    expect(HOTKEY_LABEL.voice).toBe('Voice dictation (toggle)');
    expect(HOTKEYS_STORAGE_KEY).toBe('tmuxifier.hotkeys');
    expect(MODIFIER_CODES.size).toBe(8);
  });

  test('the defaults validate against each other', () => {
    expect(validateCombo(D.switcher, { action: 'voice', combo: D.voice })).toEqual({ ok: true, combo: D.switcher });
    expect(validateCombo(D.voice, { action: 'switcher', combo: D.switcher })).toEqual({ ok: true, combo: D.voice });
  });

  test('modifiers: exactly Ctrl+Shift or Ctrl+Shift+Alt', () => {
    expect(validateRecorded(ev({}), voice)).toEqual({ ok: true, combo: { alt: false, code: 'KeyK' } });
    expect(validateRecorded(ev({ altKey: true }), voice)).toEqual({ ok: true, combo: { alt: true, code: 'KeyK' } });
    for (const o of [{ shiftKey: false }, { ctrlKey: false }, { ctrlKey: false, shiftKey: false, altKey: true }, { shiftKey: false, altKey: true }])
      expect(validateRecorded(ev(o), voice)).toMatchObject({ ok: false, reason: expect.stringMatching(/must include Ctrl\+Shift/) });
    expect(validateRecorded(ev({ metaKey: true }), voice)).toMatchObject({ ok: false, reason: expect.stringMatching(/^Cmd\/Win/) });
  });

  test('a bare modifier press is not a verdict', () => {
    for (const code of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft'])
      expect(validateRecorded(ev({ code }), voice)).toBeNull();
  });

  test('keys: letters, digits, Space and the punctuation allowlist only', () => {
    for (const code of ['KeyA', 'Digit7', 'Space', 'Comma', 'Backquote'])
      expect(validateCombo({ alt: false, code })).toEqual({ ok: true, combo: { alt: false, code } });
    for (const code of ['Tab', 'Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'F5', 'Delete', 'NumpadEnter'])
      expect(validateCombo({ alt: false, code })).toMatchObject({ ok: false, reason: expect.stringMatching(/punctuation key/) });
  });

  test('clipboard combos are refused with or without Alt', () => {
    for (const code of ['KeyC', 'KeyV'])
      for (const alt of [false, true])
        expect(validateCombo({ alt, code })).toMatchObject({ ok: false, reason: expect.stringMatching(/copy and paste/) });
  });

  test('browser-kept combos are refused, naming the combo', () => {
    for (const l of 'TNWQJIBMEZ') {
      expect(validateCombo({ alt: false, code: `Key${l}` })).toEqual({
        ok: false,
        reason: `Browsers keep Ctrl+Shift+${l} for themselves.`,
      });
      expect(validateCombo({ alt: true, code: `Key${l}` })).toMatchObject({ ok: true });
    }
    expect(validateCombo({ alt: false, code: 'Delete' })).toMatchObject({ ok: false });
  });

  test("the other action's combo is refused, naming it", () => {
    const r = validateRecorded(ev({ code: 'Space' }), voice);
    expect(r).toEqual({ ok: false, reason: 'That combo is already used by Voice dictation (toggle).' });
  });

  test('matchesCombo checks modifiers exactly', () => {
    const c = { alt: false, code: 'KeyK' };
    expect(matchesCombo(ev(), c)).toBe(true);
    expect(matchesCombo(ev({ altKey: true }), c)).toBe(false);
    expect(matchesCombo(ev(), { alt: true, code: 'KeyK' })).toBe(false);
    expect(matchesCombo(ev({ altKey: true }), { alt: true, code: 'KeyK' })).toBe(true);
    expect(matchesCombo(ev({ metaKey: true }), c)).toBe(false);
    expect(matchesCombo(ev({ code: 'KeyL' }), c)).toBe(false);
    expect(matchesCombo(ev({ ctrlKey: false }), c)).toBe(false);
    expect(matchesCombo(ev({ shiftKey: false }), c)).toBe(false);
    expect(matchesCombo(ev({ type: 'keyup' }), c)).toBe(true);
  });

  test('chordCodes covers the key and both sides of each modifier', () => {
    const a = chordCodes({ alt: false, code: 'KeyK' });
    expect(a.size).toBe(5);
    for (const c of ['KeyK', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight']) expect(a.has(c)).toBe(true);
    const b = chordCodes({ alt: true, code: 'KeyK' });
    expect(b.size).toBe(7);
    expect(b.has('AltLeft') && b.has('AltRight')).toBe(true);
  });

  test('comboLabel', () => {
    expect(comboLabel({ alt: false, code: 'KeyK' })).toBe('Ctrl+Shift+K');
    expect(comboLabel({ alt: true, code: 'Digit1' })).toBe('Ctrl+Shift+Alt+1');
    expect(comboLabel({ alt: false, code: 'Space' })).toBe('Ctrl+Shift+Space');
    expect(comboLabel({ alt: false, code: 'Comma' })).toBe('Ctrl+Shift+,');
    expect(comboLabel({ alt: false, code: 'Digit0' })).toBe('Ctrl+Shift+0');
    expect(comboLabel({ alt: false, code: 'Backquote' })).toBe('Ctrl+Shift+`');
  });

  test('parseStoredHotkeys: defaults for null, garbage, wrong version, wrong shapes', () => {
    const raws = [
      null,
      '',
      'not json',
      '[]',
      '{"v":2,"switcher":{"alt":false,"code":"KeyY"},"voice":{"alt":false,"code":"KeyD"}}',
      '{"v":1,"switcher":"KeyK"}',
      '{"v":1,"switcher":{"alt":"no","code":7}}',
    ];
    for (const raw of raws) expect(parseStoredHotkeys(raw)).toEqual(D);
  });

  test('parseStoredHotkeys keeps a valid remap of one action and defaults the other', () => {
    const raw = '{"v":1,"switcher":{"alt":true,"code":"KeyY"}}';
    expect(parseStoredHotkeys(raw)).toEqual({ switcher: { alt: true, code: 'KeyY' }, voice: D.voice });
  });

  test('parseStoredHotkeys: a stored combo the rules now refuse falls back for that action only', () => {
    const raw = '{"v":1,"switcher":{"alt":false,"code":"KeyT"},"voice":{"alt":false,"code":"KeyD"}}';
    expect(parseStoredHotkeys(raw)).toEqual({ switcher: D.switcher, voice: { alt: false, code: 'KeyD' } });
  });

  test('parseStoredHotkeys: two stored combos that collide both fall back', () => {
    expect(parseStoredHotkeys('{"v":1,"switcher":{"alt":false,"code":"Space"}}')).toEqual(D);
    expect(
      parseStoredHotkeys('{"v":1,"switcher":{"alt":false,"code":"KeyD"},"voice":{"alt":false,"code":"KeyD"}}'),
    ).toEqual(D);
  });

  test('serialize -> parse round-trips', () => {
    const m = { switcher: { alt: true, code: 'Digit3' }, voice: { alt: false, code: 'Period' } };
    const s = serializeHotkeys(m);
    expect(JSON.parse(s)).toEqual({ v: 1, ...m });
    expect(parseStoredHotkeys(s)).toEqual(m);
  });

  test('store: set validates, persists, and get reads it back at once', () => {
    const st = fakeStorage();
    const store = createHotkeyStore(st);
    expect(store.set('switcher', { alt: false, code: 'KeyY' })).toEqual({ ok: true, combo: { alt: false, code: 'KeyY' } });
    expect(store.get('switcher')).toEqual({ alt: false, code: 'KeyY' });
    expect(st.v).toBe(serializeHotkeys({ switcher: { alt: false, code: 'KeyY' }, voice: D.voice }));
    expect(store.set('switcher', { alt: false, code: 'KeyT' })).toMatchObject({ ok: false });
    expect(store.get('switcher')).toEqual({ alt: false, code: 'KeyY' });
    // a fresh store over the same storage sees it
    expect(createHotkeyStore(st).get('switcher')).toEqual({ alt: false, code: 'KeyY' });
  });

  test("store: set refuses the other action's current combo, not just its default", () => {
    const store = createHotkeyStore(fakeStorage());
    expect(store.set('voice', { alt: false, code: 'KeyD' }).ok).toBe(true);
    expect(store.set('switcher', { alt: false, code: 'KeyD' })).toEqual({
      ok: false,
      reason: 'That combo is already used by Voice dictation (toggle).',
    });
    expect(store.set('switcher', { alt: false, code: 'Space' }).ok).toBe(true);
  });

  test('store: reset restores the default, and is refused while the other action holds it', () => {
    const store = createHotkeyStore(fakeStorage());
    store.set('switcher', { alt: false, code: 'KeyY' });
    expect(store.reset('switcher')).toEqual({ ok: true, combo: D.switcher });
    expect(store.get('switcher')).toEqual(D.switcher);
    // voice takes the switcher default, then switcher cannot reset to it
    store.set('switcher', { alt: false, code: 'KeyY' });
    store.set('voice', D.switcher);
    expect(store.reset('switcher')).toMatchObject({ ok: false, reason: expect.stringMatching(/already used by Voice dictation/) });
    expect(store.get('switcher')).toEqual({ alt: false, code: 'KeyY' });
  });

  test('store: storage that throws on getItem and setItem still works in memory', () => {
    const boom = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
    const store = createHotkeyStore(boom);
    expect(store.get('voice')).toEqual(D.voice);
    expect(store.set('voice', { alt: false, code: 'KeyD' }).ok).toBe(true);
    expect(store.get('voice')).toEqual({ alt: false, code: 'KeyD' });
  });

  test('store: null storage runs on the defaults', () => {
    const store = createHotkeyStore(null);
    expect(store.get('switcher')).toEqual(D.switcher);
    expect(store.get('voice')).toEqual(D.voice);
    expect(store.set('switcher', { alt: false, code: 'KeyY' }).ok).toBe(true);
    expect(store.get('switcher')).toEqual({ alt: false, code: 'KeyY' });
  });

  test('store: recording flag', () => {
    const store = createHotkeyStore(null);
    expect(store.recording()).toBe(false);
    store.setRecording(true);
    expect(store.recording()).toBe(true);
    store.setRecording(false);
    expect(store.recording()).toBe(false);
  });

  test('the singleton exists under node without localStorage', () => {
    expect(hotkeys.get('switcher')).toEqual(D.switcher);
  });
});
