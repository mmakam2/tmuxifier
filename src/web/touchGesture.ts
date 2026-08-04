// Pure tap/hold/drag discriminator for the terminal's touch guard: the DOM
// half (wireTouchGestures, terminal.ts) feeds it touch events and a timer
// tick, and acts on what comes back. Pure so it is unit-testable — vitest has
// no DOM. `guard` is whether the app has mouse tracking on: with it OFF the
// machine reproduces the old wireTouchScroll behavior exactly (scroll from the
// first pixel, everything else inert), so plain shell prompts see zero drift.
export const HOLD_MS = 500;
export const SLOP_PX = 10;

export type GestureAction =
  | { act: 'none' }
  | { act: 'scroll'; deltaY: number }
  | { act: 'tap' }
  | { act: 'hold-press'; x: number; y: number }
  | { act: 'hold-release'; x: number; y: number }
  | { act: 'cancelled' };

export interface TouchGesture {
  readonly holdPending: boolean;
  start(x: number, y: number, touches: number, guard: boolean): void;
  move(x: number, y: number, touches: number): GestureAction;
  timerFired(): GestureAction;
  end(): GestureAction;
  cancel(): GestureAction;
}

export function createTouchGesture(): TouchGesture {
  // pending: guard on, within slop, timer not yet fired — could still become
  // any of tap/hold/drag. passive: guard off — the legacy scroll-only path.
  type Phase = 'idle' | 'pending' | 'drag' | 'hold' | 'passive';
  let phase: Phase = 'idle';
  let x0 = 0, y0 = 0, lastY = 0;
  const NONE: GestureAction = { act: 'none' };
  return {
    get holdPending() { return phase === 'pending'; },
    start(x, y, touches, guard) {
      if (touches !== 1) { phase = 'idle'; return; }
      x0 = x; y0 = y; lastY = y;
      phase = guard ? 'pending' : 'passive';
    },
    move(x, y, touches) {
      if (phase === 'idle' || phase === 'hold') return NONE;
      if (touches !== 1) {
        const was = phase;
        phase = 'idle';
        return was === 'pending' ? { act: 'cancelled' } : NONE;
      }
      if (phase === 'pending') {
        if (Math.abs(x - x0) <= SLOP_PX && Math.abs(y - y0) <= SLOP_PX) return NONE;
        phase = 'drag'; // lastY is still y0, so the pre-slop travel rides the first wheel
      }
      const deltaY = lastY - y; // finger up = positive = scroll down, wheel's sign convention
      lastY = y;
      if (deltaY === 0) return NONE;
      return { act: 'scroll', deltaY };
    },
    timerFired() {
      if (phase !== 'pending') return NONE; // stale timer — the DOM half clears, this is the backstop
      phase = 'hold';
      return { act: 'hold-press', x: x0, y: y0 };
    },
    end() {
      const was = phase;
      phase = 'idle';
      if (was === 'pending') return { act: 'tap' };
      if (was === 'hold') return { act: 'hold-release', x: x0, y: y0 };
      return NONE;
    },
    cancel() {
      const was = phase;
      phase = 'idle';
      // A dispatched mousedown must not be orphaned: xterm would believe the
      // button is still held long after the finger is gone.
      if (was === 'hold') return { act: 'hold-release', x: x0, y: y0 };
      return was === 'pending' ? { act: 'cancelled' } : NONE;
    },
  };
}
