import { describe, expect, test } from 'vitest';
import { CHORD_IDLE, chordReduce } from '../src/web/agentSwitcherChord.ts';

const COMBO = { alt: false, code: 'KeyK' };
const MODS = { ctrlKey: true, shiftKey: true, altKey: false, metaKey: false };
const key = (type, code, o = {}) => ({ t: 'key', ev: { type, code, ...MODS, ...o } });

function run(inputs, ctx = {}) {
  const c = { combo: COMBO, enabled: true, ...ctx };
  let state = CHORD_IDLE;
  const effects = [];
  const swallowed = [];
  for (const input of inputs) {
    const r = chordReduce(state, input, c);
    state = r.state;
    effects.push(...r.effects);
    swallowed.push(r.swallow);
  }
  return { state, effects, swallowed };
}

describe('chordReduce', () => {
  test('the chord opens on its first keydown and swallows it', () => {
    const r = run([key('keydown', 'KeyK')]);
    expect(r.effects).toEqual([{ t: 'open' }]);
    expect(r.swallowed).toEqual([true]);
    expect(r.state.phase).toBe('open');
    expect(r.state.combo).toEqual(COMBO);
    expect(r.state.held).toEqual(['KeyK']);
  });

  test('a disabled chord passes its keydown through untouched', () => {
    const r = run([key('keydown', 'KeyK')], { enabled: false });
    expect(r.state.phase).toBe('idle');
    expect(r.swallowed).toEqual([false]);
    expect(r.effects).toEqual([]);
  });

  test('plain Ctrl+K and Alt+K never open it', () => {
    const r = run([
      key('keydown', 'KeyK', { shiftKey: false }),
      key('keydown', 'KeyK', { ctrlKey: false, altKey: true }),
    ]);
    expect(r.state.phase).toBe('idle');
    expect(r.swallowed).toEqual([false, false]);
    expect(r.effects).toEqual([]);
  });

  test('an exact-modifier mismatch does not open it', () => {
    const r = run([key('keydown', 'KeyK', { altKey: true })]);
    expect(r.state.phase).toBe('idle');
    expect(r.swallowed).toEqual([false]);
    const r2 = run([key('keydown', 'KeyK')], { combo: { alt: true, code: 'KeyK' } });
    expect(r2.state.phase).toBe('idle');
    expect(r2.swallowed).toEqual([false]);
  });

  test('the chord key, ArrowDown and ArrowUp step; repeats step too', () => {
    const r = run([
      key('keydown', 'KeyK'),
      key('keydown', 'KeyK', { repeat: true }),
      key('keydown', 'KeyK', { repeat: true }),
      key('keydown', 'ArrowDown'),
      key('keydown', 'ArrowUp'),
    ]);
    expect(r.effects).toEqual([
      { t: 'open' },
      { t: 'step', delta: 1 },
      { t: 'step', delta: 1 },
      { t: 'step', delta: 1 },
      { t: 'step', delta: -1 },
    ]);
    expect(r.swallowed).toEqual([true, true, true, true, true]);
    expect(r.state.phase).toBe('open');
  });

  test('releasing Ctrl commits; releasing Shift commits', () => {
    const a = run([key('keydown', 'KeyK'), key('keyup', 'ControlLeft', { ctrlKey: false })]);
    expect(a.effects).toEqual([{ t: 'open' }, { t: 'commit' }]);
    expect(a.swallowed).toEqual([true, true]);
    expect(a.state.phase).toBe('drain');
    const b = run([key('keydown', 'KeyK'), key('keyup', 'ShiftRight', { shiftKey: false })]);
    expect(b.effects).toEqual([{ t: 'open' }, { t: 'commit' }]);
    expect(b.swallowed).toEqual([true, true]);
    expect(b.state.phase).toBe('drain');
  });

  test('any key event arriving without Ctrl or Shift commits', () => {
    const r = run([key('keydown', 'KeyK'), key('keydown', 'KeyX', { ctrlKey: false })]);
    expect(r.effects).toEqual([{ t: 'open' }, { t: 'commit' }]);
    expect(r.swallowed).toEqual([true, true]);
    expect(r.state.phase).toBe('drain');
    expect(r.state.held).toEqual(['KeyK', 'KeyX']);
  });

  test('Esc cancels and its keyup is swallowed', () => {
    const r = run([key('keydown', 'KeyK'), key('keydown', 'Escape'), key('keyup', 'Escape')]);
    expect(r.effects).toEqual([{ t: 'open' }, { t: 'cancel' }]);
    expect(r.swallowed).toEqual([true, true, true]);
    expect(r.state.phase).toBe('drain');
    expect(r.state.held).toEqual(['KeyK']);
  });

  test('blur cancels without committing and returns to idle', () => {
    const r = run([key('keydown', 'KeyK'), { t: 'blur' }]);
    expect(r.effects).toEqual([{ t: 'open' }, { t: 'cancel' }]);
    expect(r.state).toEqual({ phase: 'idle', combo: null, held: [] });
    expect(r.swallowed[1]).toBe(false);
  });

  test('clicking a row commits to that row', () => {
    const r = run([key('keydown', 'KeyK'), { t: 'click', index: 3 }]);
    expect(r.effects).toEqual([{ t: 'open' }, { t: 'commit', index: 3 }]);
    expect(r.state.phase).toBe('drain');
    expect(r.swallowed[1]).toBe(false);
  });

  test('a click while not open passes with no effect', () => {
    const r = run([{ t: 'click', index: 1 }, { t: 'blur' }]);
    expect(r.effects).toEqual([]);
    expect(r.swallowed).toEqual([false, false]);
    expect(r.state.phase).toBe('idle');
  });

  test('every key while open is swallowed, with its keyup', () => {
    const r = run([key('keydown', 'KeyK'), key('keydown', 'KeyC'), key('keyup', 'KeyC')]);
    expect(r.swallowed).toEqual([true, true, true]);
    expect(r.effects).toEqual([{ t: 'open' }]);
    expect(r.state.phase).toBe('open');
    expect(r.state.held).toEqual(['KeyK']);
  });

  test('Ctrl released first while the chord key is held: its repeats and keyup are still swallowed', () => {
    const r = run([
      key('keydown', 'KeyK'),
      key('keyup', 'ControlLeft', { ctrlKey: false }),
      key('keydown', 'KeyK', { ctrlKey: false, repeat: true }),
      key('keydown', 'KeyK', { ctrlKey: false, repeat: true }),
      key('keyup', 'KeyK', { ctrlKey: false }),
      key('keyup', 'ShiftLeft', { ctrlKey: false, shiftKey: false }),
    ]);
    expect(r.swallowed).toEqual([true, true, true, true, true, true]);
    expect(r.effects.map((e) => e.t)).toEqual(['open', 'commit']);
    expect(r.state.phase).toBe('idle');
  });

  test('after the drain, the next ordinary key passes', () => {
    const r = run([
      key('keydown', 'KeyK'),
      key('keyup', 'ControlLeft', { ctrlKey: false }),
      key('keyup', 'KeyK', { ctrlKey: false }),
      key('keyup', 'ShiftLeft', { ctrlKey: false, shiftKey: false }),
      key('keydown', 'KeyA', { ctrlKey: false, shiftKey: false }),
    ]);
    expect(r.swallowed).toEqual([true, true, true, true, false]);
    expect(r.state.phase).toBe('idle');
  });

  test('after Esc, with the modifiers still down, the chord key reopens', () => {
    const r = run([
      key('keydown', 'KeyK'),
      key('keydown', 'Escape'),
      key('keyup', 'Escape'),
      key('keyup', 'KeyK'),
      key('keydown', 'KeyK'),
    ]);
    expect(r.effects.map((e) => e.t)).toEqual(['open', 'cancel', 'open']);
    expect(r.swallowed).toEqual([true, true, true, true, true]);
    expect(r.state.phase).toBe('open');
    expect(r.state.held).toEqual(['KeyK']);
  });

  test('a tap: down, up, release -> open then commit, nothing leaks', () => {
    const r = run([
      key('keydown', 'KeyK'),
      key('keyup', 'KeyK'),
      key('keyup', 'ControlLeft', { ctrlKey: false }),
      key('keyup', 'ShiftLeft', { ctrlKey: false, shiftKey: false }),
    ]);
    expect(r.swallowed).toEqual([true, true, true, true]);
    expect(r.effects.map((e) => e.t)).toEqual(['open', 'commit']);
    expect(r.state.phase).toBe('idle');
  });

  test('an Alt combo opens only with Alt, and Alt may be released while stepping', () => {
    const ctx = { combo: { alt: true, code: 'KeyK' } };
    const no = run([key('keydown', 'KeyK')], ctx);
    expect(no.state.phase).toBe('idle');
    expect(no.swallowed).toEqual([false]);
    const r = run(
      [
        key('keydown', 'KeyK', { altKey: true }),
        key('keyup', 'AltLeft', { altKey: false }),
        key('keydown', 'KeyK', { repeat: true }),
        key('keydown', 'ArrowDown'),
      ],
      ctx,
    );
    expect(r.effects).toEqual([{ t: 'open' }, { t: 'step', delta: 1 }, { t: 'step', delta: 1 }]);
    expect(r.swallowed).toEqual([true, true, true, true]);
    expect(r.state.phase).toBe('open');
    expect(r.state.held).toEqual(['KeyK', 'ArrowDown']);
  });

  test('a repeat of the chord key arriving while idle is swallowed without opening', () => {
    const r = run([key('keydown', 'KeyK', { repeat: true })]);
    expect(r.swallowed).toEqual([true]);
    expect(r.effects).toEqual([]);
    expect(r.state.phase).toBe('idle');
  });

  test('a blur during the drain returns to idle', () => {
    const r = run([key('keydown', 'KeyK'), key('keyup', 'ControlLeft', { ctrlKey: false }), { t: 'blur' }]);
    expect(r.effects.map((e) => e.t)).toEqual(['open', 'commit']);
    expect(r.state).toEqual({ phase: 'idle', combo: null, held: [] });
  });

  test('the reducer does not mutate its input state', () => {
    const open = chordReduce(CHORD_IDLE, key('keydown', 'KeyK'), { combo: COMBO, enabled: true }).state;
    const before = JSON.stringify(open);
    chordReduce(open, key('keydown', 'KeyX'), { combo: COMBO, enabled: true });
    chordReduce(open, key('keyup', 'ControlLeft', { ctrlKey: false }), { combo: COMBO, enabled: true });
    expect(JSON.stringify(open)).toBe(before);
    expect(JSON.stringify(CHORD_IDLE)).toBe('{"phase":"idle","combo":null,"held":[]}');
  });
  test('a disabled chord is fully inert: an idle repeat of the chord key passes (pins existing behaviour)', () => {
    const off = run([key('keydown', 'KeyK', { repeat: true })], { enabled: false });
    expect(off.swallowed).toEqual([false]);
    expect(off.state.phase).toBe('idle');
    expect(off.effects).toEqual([]);
    const on = run([key('keydown', 'KeyK', { repeat: true })]);
    expect(on.swallowed).toEqual([true]);
  });

  test('a reopen from drain keeps the keyups still owed', () => {
    const r = run([
      key('keydown', 'KeyK'),
      key('keydown', 'Escape'),
      key('keyup', 'KeyK'),
      key('keydown', 'KeyK'),
      key('keyup', 'ControlLeft', { ctrlKey: false }),
      key('keyup', 'Escape', { ctrlKey: false }),
      key('keyup', 'KeyK', { ctrlKey: false }),
      key('keyup', 'ShiftLeft', { ctrlKey: false, shiftKey: false }),
    ]);
    expect(r.effects.map((e) => e.t)).toEqual(['open', 'cancel', 'open', 'commit']);
    expect(r.swallowed).toEqual([true, true, true, true, true, true, true, true]);
    expect(r.state.phase).toBe('idle');
    expect(r.state.held).toEqual([]);
  });

  test('in drain, a non-repeat keydown of a held code is swallowed and does not reopen (pins existing behaviour)', () => {
    const r = run([
      key('keydown', 'KeyK'),
      key('keyup', 'ControlLeft', { ctrlKey: false }),
      key('keydown', 'KeyK'),
    ]);
    expect(r.effects.map((e) => e.t)).toEqual(['open', 'commit']);
    expect(r.swallowed).toEqual([true, true, true]);
    expect(r.state.phase).toBe('drain');
    expect(r.state.held).toEqual(['KeyK']);
  });
});
