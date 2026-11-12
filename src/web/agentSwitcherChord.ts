// The agent switcher's held chord (Cmd-Tab style): hold Ctrl+Shift, tap the combo key to open,
// tap again or press the arrows to step, release a modifier to commit, Esc or blur to cancel.
// Pure reducer: no DOM. A later module feeds it real key events and runs its effects.
//
// The property that matters: no event belonging to a chord may reach the terminal. After a
// commit or cancel the operator's fingers are still on keys, so the `drain` phase keeps
// swallowing those keys' auto-repeats and keyups (`held`) until they are all up, in any release
// order. `held` never holds a modifier code and never holds a duplicate.

import { MODIFIER_CODES, matchesCombo, type Combo, type KeyLike } from './hotkeys';

export type ChordPhase = 'idle' | 'open' | 'drain';
// held: non-modifier codes whose keydown was swallowed and whose keyup is still owed.
export interface ChordState {
  phase: ChordPhase;
  combo: Combo | null;
  held: string[];
}
export const CHORD_IDLE: ChordState = { phase: 'idle', combo: null, held: [] };

export type ChordInput = { t: 'key'; ev: KeyLike } | { t: 'blur' } | { t: 'click'; index: number };
export type ChordEffect =
  | { t: 'open' }
  | { t: 'step'; delta: 1 | -1 }
  | { t: 'commit'; index?: number }
  | { t: 'cancel' };
export interface ChordResult {
  state: ChordState;
  swallow: boolean;
  effects: ChordEffect[];
}

const pass = (state: ChordState): ChordResult => ({ state, swallow: false, effects: [] });
const take = (state: ChordState, effects: ChordEffect[] = []): ChordResult => ({ state, swallow: true, effects });
const add = (held: string[], code: string): string[] =>
  MODIFIER_CODES.has(code) || held.includes(code) ? held : [...held, code];
const drop = (held: string[], code: string): string[] => (held.includes(code) ? held.filter((c) => c !== code) : held);

export function chordReduce(
  state: ChordState,
  input: ChordInput,
  ctx: { combo: Combo; enabled: boolean },
): ChordResult {
  if (state.phase === 'open') return reduceOpen(state, input, ctx);
  if (state.phase === 'drain') return reduceDrain(state, input, ctx);
  return reduceIdle(state, input, ctx);
}

function opens(ev: KeyLike, held: string[], ctx: { combo: Combo; enabled: boolean }): boolean {
  return ev.type === 'keydown' && !ev.repeat && ctx.enabled && matchesCombo(ev, ctx.combo) && !held.includes(ev.code);
}

const openResult = (code: string, ctx: { combo: Combo }): ChordResult =>
  take({ phase: 'open', combo: ctx.combo, held: [code] }, [{ t: 'open' }]);

function reduceIdle(state: ChordState, input: ChordInput, ctx: { combo: Combo; enabled: boolean }): ChordResult {
  if (input.t !== 'key') return pass(state);
  const ev = input.ev;
  if (opens(ev, [], ctx)) return openResult(ev.code, ctx);
  // A key still held from before a blur must not type its repeats.
  if (ev.type === 'keydown' && ev.repeat && ctx.enabled && matchesCombo(ev, ctx.combo)) return take(state);
  return pass(state);
}

function reduceOpen(state: ChordState, input: ChordInput, ctx: { combo: Combo; enabled: boolean }): ChordResult {
  if (input.t === 'blur') return { state: CHORD_IDLE, swallow: false, effects: [{ t: 'cancel' }] };
  if (input.t === 'click')
    return { state: { ...state, phase: 'drain' }, swallow: false, effects: [{ t: 'commit', index: input.index }] };
  const ev = input.ev;
  const combo = state.combo ?? ctx.combo;
  const down = ev.type === 'keydown';
  const up = ev.type === 'keyup';
  if (!(ev.ctrlKey && ev.shiftKey)) {
    const held = up ? drop(state.held, ev.code) : down ? add(state.held, ev.code) : state.held;
    return take({ ...state, phase: 'drain', held }, [{ t: 'commit' }]);
  }
  if (down && ev.code === 'Escape')
    return take({ ...state, phase: 'drain', held: add(state.held, ev.code) }, [{ t: 'cancel' }]);
  if (down && (ev.code === combo.code || ev.code === 'ArrowDown'))
    return take({ ...state, held: add(state.held, ev.code) }, [{ t: 'step', delta: 1 }]);
  if (down && ev.code === 'ArrowUp') return take({ ...state, held: add(state.held, ev.code) }, [{ t: 'step', delta: -1 }]);
  if (down) return take({ ...state, held: add(state.held, ev.code) });
  if (up) return take({ ...state, held: drop(state.held, ev.code) });
  return take(state);
}

function reduceDrain(state: ChordState, input: ChordInput, ctx: { combo: Combo; enabled: boolean }): ChordResult {
  if (input.t === 'blur') return { state: CHORD_IDLE, swallow: false, effects: [] };
  if (input.t === 'click') return pass(state);
  const ev = input.ev;
  if (opens(ev, state.held, ctx)) return openResult(ev.code, ctx);
  let r: ChordResult;
  if (state.held.includes(ev.code)) {
    r = take(ev.type === 'keyup' ? { ...state, held: drop(state.held, ev.code) } : state);
  } else if (ev.type === 'keyup' && MODIFIER_CODES.has(ev.code)) {
    r = take(state);
  } else {
    r = pass(state);
  }
  if (r.state.held.length === 0 && !ev.ctrlKey && !ev.shiftKey) r = { ...r, state: CHORD_IDLE };
  return r;
}
