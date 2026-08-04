import { test, expect } from 'vitest';
import { createTouchGesture, holdKeepsFocus, HOLD_MS, SLOP_PX } from '../src/web/touchGesture.ts';

test("guard off: scroll from the first pixel, end is inert — today's behavior exactly", () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, false);
  expect(g.holdPending).toBe(false);
  expect(g.move(100, 197, 1)).toEqual({ act: 'scroll', deltaY: 3 });
  expect(g.move(100, 190, 1)).toEqual({ act: 'scroll', deltaY: 7 });
  expect(g.end()).toEqual({ act: 'none' });
});

test('guard on: release within slop and before the timer is a tap', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  expect(g.holdPending).toBe(true);
  expect(g.move(104, 203, 1)).toEqual({ act: 'none' }); // jitter, not a drag
  expect(g.end()).toEqual({ act: 'tap' });
  expect(g.holdPending).toBe(false);
});

test('guard on: the hold timer fires a press at the START coords, release a matching mouseup', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  expect(g.timerFired()).toEqual({ act: 'hold-press', x: 100, y: 200 });
  expect(g.holdPending).toBe(false);
  expect(g.end()).toEqual({ act: 'hold-release', x: 100, y: 200 });
});

test('guard on: moving past slop becomes a drag and no scroll distance is lost', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  const a = g.move(100, 200 - (SLOP_PX + 5), 1); // 15px up in one move
  expect(a).toEqual({ act: 'scroll', deltaY: SLOP_PX + 5 }); // the pre-slop travel is the first wheel
  expect(g.move(100, 180, 1)).toEqual({ act: 'scroll', deltaY: 5 });
  expect(g.end()).toEqual({ act: 'none' }); // a drag never taps
  expect(g.timerFired()).toEqual({ act: 'none' }); // a stale timer is inert
});

test('a second finger cancels a pending gesture', () => {
  const g = createTouchGesture();
  g.start(100, 200, 1, true);
  expect(g.move(100, 200, 2)).toEqual({ act: 'cancelled' });
  expect(g.end()).toEqual({ act: 'none' });
});

test('multi-touch start never arms anything', () => {
  const g = createTouchGesture();
  g.start(100, 200, 2, true);
  expect(g.holdPending).toBe(false);
  expect(g.move(100, 150, 1)).toEqual({ act: 'none' });
  expect(g.end()).toEqual({ act: 'none' });
});

test('touchcancel after the press dispatched still releases the button', () => {
  // An orphaned mousedown would leave xterm believing the button is held.
  const g = createTouchGesture();
  g.start(50, 60, 1, true);
  g.timerFired();
  expect(g.cancel()).toEqual({ act: 'hold-release', x: 50, y: 60 });
});

test('moves after the hold press are ignored — a held finger drifting is not a drag', () => {
  const g = createTouchGesture();
  g.start(50, 60, 1, true);
  g.timerFired();
  expect(g.move(80, 90, 1)).toEqual({ act: 'none' });
});

test('constants match the spec', () => {
  expect(HOLD_MS).toBe(500);
  expect(SLOP_PX).toBe(10);
});

test('holdKeepsFocus: keyboard visibility decides, not focus alone — Android back-gesture leaves the textarea focused with the keyboard hidden', () => {
  // phone, keyboard actually up, mid-typing → keep it up
  expect(holdKeepsFocus(true, true, true)).toBe(true);
  // phone, focused but keyboard HIDDEN (back-gesture) → must NOT re-summon
  expect(holdKeepsFocus(true, true, false)).toBe(false);
  // phone, unfocused → nothing to keep
  expect(holdKeepsFocus(false, true, false)).toBe(false);
  expect(holdKeepsFocus(false, true, true)).toBe(false);
  // not a coarse phone: focus is the only evidence there is
  expect(holdKeepsFocus(true, false, false)).toBe(true);
  expect(holdKeepsFocus(false, false, false)).toBe(false);
});
