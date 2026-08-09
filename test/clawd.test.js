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
  expect(CLAWD_VARIANTS.map((v) => v.id)).toEqual(['off', 'static', 'star', 'wiggle', 'pace', 'big-hop']);
  expect(new Set(CLAWD_VARIANTS.map((v) => v.id)).size).toBe(6);
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
  saveClawdVariant('static', s);
  expect(loadClawdVariant(s)).toBe('static');          // the motionless-sprite id is a first-class value
  expect(loadClawdVariant(memStorage({ 'tmuxifier.clawdAnim': 'hop' }))).toBe('star'); // unknown stored value
  expect(normalizeClawdVariant(undefined)).toBe('star');
  expect(normalizeClawdVariant(42)).toBe('star');
  expect(loadClawdVariant()).toBe('star');             // no storage at all (node has no localStorage)
});

// The server-backed cache. The pref is authoritative in data/ui-settings.json;
// this module keeps a synchronous copy so the render sites never await. The
// cache is module-level, so it persists across tests in this file — each test
// below sets it explicitly before reading it.
import { setClawdVariant, currentClawdVariant, hasStoredClawdPref } from '../src/web/clawd.ts';

test('setClawdVariant normalizes, caches, and refreshes the mirror', () => {
  const store = memStorage();
  expect(setClawdVariant('pace', store)).toBe('pace');
  expect(store.getItem('tmuxifier.clawdAnim')).toBe('pace');
  expect(currentClawdVariant()).toBe('pace');
  // junk from the server (stale slug after a rename) falls back to default
  expect(setClawdVariant('gone-variant', store)).toBe(DEFAULT_CLAWD_VARIANT);
  expect(currentClawdVariant()).toBe(DEFAULT_CLAWD_VARIANT);
});

test('hasStoredClawdPref distinguishes never-set from set', () => {
  expect(hasStoredClawdPref(memStorage())).toBe(false);
  expect(hasStoredClawdPref(memStorage({ 'tmuxifier.clawdAnim': 'star' }))).toBe(true);
});

// The boot-time migration decision, extracted from main.ts's loadUiSettings so
// the rule is testable without a DOM or a fetch: a PATCH payload is produced
// ONLY for a genuine legacy pref (server unset AND a local mirror key present).
// The null return for server-unset + nothing-stored is load-bearing — see the
// comment on the helper.
import { clawdMigrationPatch } from '../src/web/clawd.ts';

test('clawdMigrationPatch: only a genuine legacy pref produces a payload', () => {
  // server unset + a local value -> migrate it, normalized
  expect(clawdMigrationPatch(null, 'pace')).toEqual({ clawdAnim: 'pace' });
  // server unset + junk local value -> the default, not the junk
  expect(clawdMigrationPatch(null, 'hop')).toEqual({ clawdAnim: DEFAULT_CLAWD_VARIANT });
  // server unset + nothing stored -> nothing to migrate; persisting anything
  // here would mint a phantom pref the user never chose.
  expect(clawdMigrationPatch(null, null)).toBe(null);
  // server already has a value -> never re-PATCH it, whatever the mirror says
  expect(clawdMigrationPatch('pace', 'big-hop')).toBe(null);
  expect(clawdMigrationPatch('pace', null)).toBe(null);
});
