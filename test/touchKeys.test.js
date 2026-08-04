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
  expect(seqFor('down', true)).toBe('\x1bOB');
  expect(seqFor('right', true)).toBe('\x1bOC');
  expect(seqFor('left', true)).toBe('\x1bOD');
});

test('seqFor: ctrl is a modifier, not a sequence', () => {
  expect(seqFor('ctrl', false)).toBe(null);
});

test('every catalog entry except the non-key controls resolves to bytes', () => {
  for (const k of TOUCH_KEYS) {
    if (k.id === 'ctrl' || k.id === 'compose') continue; // modifier / mode toggle
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

test('sticky ctrl: disarm() before typing restores passthrough', () => {
  const s = createStickyCtrl();
  s.arm();
  s.disarm();
  expect(s.armed).toBe(false);
  expect(s.transform('c')).toBe('c');
});

// Case folding is a RAW a–z code-point shift, not toUpperCase(): the Unicode
// uppercase of 'ß' is the two-character 'SS', whose first code unit is 'S' —
// masking it would send \x13 (XOFF) and freeze the pane's output. 'ı' and 'ſ'
// uppercase to 'I'/'S' the same way.
test('sticky ctrl: unicode letters pass through instead of masking to a control byte', () => {
  for (const ch of ['ß', 'ı', 'ſ']) {
    const s = createStickyCtrl();
    s.arm();
    expect(s.transform(ch)).toBe(ch);
    expect(s.armed).toBe(false);
  }
});

test('sticky ctrl: the ASCII range still masks across the whole alphabet', () => {
  const s = createStickyCtrl();
  for (let i = 0; i < 26; i++) {
    const lower = String.fromCharCode(0x61 + i);
    const upper = String.fromCharCode(0x41 + i);
    const want = String.fromCharCode(i + 1); // ^A..^Z
    s.arm();
    expect(s.transform(lower)).toBe(want);
    s.arm();
    expect(s.transform(upper)).toBe(want);
  }
  // The non-letter maskable span: @ [ \ ] ^ _
  for (const [ch, want] of [['@', '\x00'], ['[', '\x1b'], [']', '\x1d'], ['_', '\x1f']]) {
    s.arm();
    expect(s.transform(ch)).toBe(want);
  }
});

test('ctrl-c is a dedicated cap sending ETX regardless of cursor mode', () => {
  expect(TOUCH_KEYS.some((k) => k.id === 'ctrl-c')).toBe(true);
  expect(seqFor('ctrl-c', false)).toBe('\x03');
  expect(seqFor('ctrl-c', true)).toBe('\x03');
});

test('enter and compose are the only pinned caps — nothing else may leave the scroller', () => {
  // compose is pinned but display-gated to `.composing` (it is the composer
  // CLOSER), so the idle bar still renders exactly one pinned cap and keeps
  // the round-2 344px budget; the geometry itself is pinned by the e2e suites.
  for (const k of TOUCH_KEYS) {
    expect(!!k.pinned).toBe(k.id === 'enter' || k.id === 'compose');
  }
});

test('no arrow caps in the catalog — a scroll begun on a cap fires it, and arrows made the strip scroll on narrow screens', () => {
  for (const k of TOUCH_KEYS) {
    expect(['up', 'down', 'left', 'right']).not.toContain(k.id);
  }
});

test('the compose cap is pinned, sits before enter, and maps to no sequence', () => {
  const compose = TOUCH_KEYS.find((k) => k.id === 'compose');
  expect(compose?.pinned).toBe(true);
  const ids = TOUCH_KEYS.map((k) => k.id);
  expect(ids.indexOf('compose')).toBeLessThan(ids.indexOf('enter'));
  // A mode toggle, like ctrl: it must never send bytes itself.
  expect(seqFor('compose', false)).toBeNull();
  expect(seqFor('compose', true)).toBeNull();
});
