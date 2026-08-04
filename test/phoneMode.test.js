import { test, expect } from 'vitest';
import { keyboardOpen, KB_OPEN_PX } from '../src/web/phoneMode.ts';

test('keyboardOpen: only a large layout-vs-visual delta reads as a keyboard', () => {
  expect(keyboardOpen(844, 844)).toBe(false);              // idle
  expect(keyboardOpen(844, 844 - KB_OPEN_PX)).toBe(false); // at the threshold: not yet
  expect(keyboardOpen(844, 844 - KB_OPEN_PX - 1)).toBe(true);
  expect(keyboardOpen(844, 500)).toBe(true);               // a real keyboard (~344px)
  expect(keyboardOpen(844, 800)).toBe(false);              // URL-bar-scale squeeze keeps the bar
});

test('keyboardOpen: zoom cannot read as a keyboard, because vvh is scale-corrected', () => {
  // phoneMode feeds it h = round(vv.height * vv.scale): pinch-zoomed 2x with no
  // keyboard, vv.height halves but scale doubles, so h ≈ innerHeight → closed.
  expect(keyboardOpen(844, Math.round((844 / 2) * 2))).toBe(false);
});

test('threshold matches the spec', () => {
  expect(KB_OPEN_PX).toBe(150);
});
