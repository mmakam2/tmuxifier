import { test, expect } from 'vitest';
import {
  CLAWD_BODY, CLAWD_FEET, CLAWD_VARIANTS, DEFAULT_CLAWD_VARIANT, STAR_FRAMES,
  loadClawdVariant, normalizeClawdVariant, saveClawdVariant,
} from '../src/web/clawd.ts';

// The sprite must stay renderable by the bundled mono face: Unicode block
// elements (U+2580–U+259F) and spaces only. Anything else risks tofu in the
// chip, which a node test can catch even though the DOM builder cannot be
// exercised here (vitest runs environment:'node' — no DOM by convention).
test('clawd frames: block-element glyphs only, feet narrower than body', () => {
  const blockOrSpace = /^[▀-▟ ]+$/;
  expect(CLAWD_BODY).toMatch(blockOrSpace);
  expect(CLAWD_FEET).toMatch(blockOrSpace);
  expect(CLAWD_BODY.length).toBe(7);
  expect(CLAWD_FEET.length).toBe(5);
  // Feet are strictly narrower so the centered stack reads as a body on legs.
  expect(CLAWD_FEET.length).toBeLessThan(CLAWD_BODY.length);
});

// Minimal injected stand-in for localStorage — vitest is environment:'node',
// so the real one does not exist here (which the last assertion relies on).
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

test('variant catalog: ordered ids, star default, labelled rows', () => {
  expect(CLAWD_VARIANTS.map((v) => v.id)).toEqual(['off', 'star', 'wiggle', 'pace', 'big-hop']);
  expect(new Set(CLAWD_VARIANTS.map((v) => v.id)).size).toBe(5);
  expect(DEFAULT_CLAWD_VARIANT).toBe('star');
  for (const v of CLAWD_VARIANTS) {
    expect(typeof v.label).toBe('string');
    expect(v.label.length).toBeGreaterThan(0);
    expect(typeof v.description).toBe('string');
    expect(v.description.length).toBeGreaterThan(0);
  }
});

test('star frames: ten single-glyph frames in a ping-pong cycle', () => {
  expect(STAR_FRAMES).toHaveLength(10);
  for (const f of STAR_FRAMES) expect(f).toHaveLength(1);
  // Ping-pong: frame i mirrors frame (10 - i) % 10, so the bloom closes back
  // the same way it opened.
  for (let i = 0; i < STAR_FRAMES.length; i++) {
    expect(STAR_FRAMES[i]).toBe(STAR_FRAMES[(STAR_FRAMES.length - i) % STAR_FRAMES.length]);
  }
});

test('pref: round-trips, and every failure path falls back to the default', () => {
  const s = memStorage();
  expect(loadClawdVariant(s)).toBe('star');            // empty storage
  saveClawdVariant('pace', s);
  expect(loadClawdVariant(s)).toBe('pace');            // round-trip
  expect(loadClawdVariant(memStorage({ 'tmuxifier.clawdAnim': 'hop' }))).toBe('star'); // unknown stored value
  expect(normalizeClawdVariant(undefined)).toBe('star');
  expect(normalizeClawdVariant(42)).toBe('star');
  expect(loadClawdVariant()).toBe('star');             // no storage at all (node has no localStorage)
});
