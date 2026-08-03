import { test, expect } from 'vitest';
import { TOUCH_KEYS, seqFor, createStickyCtrl } from '../src/web/touchKeys.ts';

test('seqFor maps the plain keys', () => {
  expect(seqFor('esc', false)).toBe('\x1b');
  expect(seqFor('tab', false)).toBe('\t');
  expect(seqFor('shift-tab', false)).toBe('\x1b[Z');
  expect(seqFor('enter', false)).toBe('\r');
});

test('seqFor arrows follow cursor-keys mode (DECCKM)', () => {
  expect(seqFor('up', false)).toBe('\x1b[A');
  expect(seqFor('down', false)).toBe('\x1b[B');
  expect(seqFor('right', false)).toBe('\x1b[C');
  expect(seqFor('left', false)).toBe('\x1b[D');
  expect(seqFor('up', true)).toBe('\x1bOA');
  expect(seqFor('left', true)).toBe('\x1bOD');
});

test('seqFor: ctrl is a modifier, not a sequence', () => {
  expect(seqFor('ctrl', false)).toBe(null);
});

test('every catalog entry except ctrl resolves to bytes', () => {
  for (const k of TOUCH_KEYS) {
    if (k.id === 'ctrl') continue;
    expect(typeof seqFor(k.id, false)).toBe('string');
  }
});

test('sticky ctrl: ctrl-ifies the next single character then disarms', () => {
  const s = createStickyCtrl();
  s.arm();
  expect(s.armed).toBe(true);
  expect(s.transform('c')).toBe('\x03');
  expect(s.armed).toBe(false);
  expect(s.transform('c')).toBe('c'); // disarmed: passthrough
});

test('sticky ctrl: c and C both give ^C; space gives NUL', () => {
  const s = createStickyCtrl();
  s.arm();
  expect(s.transform('C')).toBe('\x03');
  s.arm();
  expect(s.transform(' ')).toBe('\x00');
});

test('sticky ctrl: non-maskable or multi-byte input passes through and disarms', () => {
  const s = createStickyCtrl();
  s.arm();
  expect(s.transform('\x1b[A')).toBe('\x1b[A');
  expect(s.armed).toBe(false);
  s.arm();
  expect(s.transform('é')).toBe('é');
  expect(s.armed).toBe(false);
});

test('sticky ctrl: unarmed transform is identity', () => {
  const s = createStickyCtrl();
  expect(s.transform('x')).toBe('x');
});
