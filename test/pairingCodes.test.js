import { test, expect } from 'vitest';
import { createPairingCodes } from '../src/server/pairingCodes.js';

test('mint returns a XXXX-XXXX code that take() accepts once, in any typed form', () => {
  const pc = createPairingCodes();
  const { code, expiresAt } = pc.mint();
  expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  expect(expiresAt).toBeGreaterThan(Date.now());
  // lowercase, no dash, stray spaces — all the ways a human types it
  expect(pc.take(` ${code.toLowerCase().replace('-', '')} `)).toBe(true);
  expect(pc.take(code)).toBe(false); // single use
});

test('an unknown code is refused and spends nothing', () => {
  const pc = createPairingCodes();
  pc.mint();
  expect(pc.take('AAAA-AAAA')).toBe(false);
  expect(pc._size()).toBe(1); // a wrong guess must not burn the operator's code
});

test('codes expire at ttlMs', () => {
  let t = 1000;
  const pc = createPairingCodes({ ttlMs: 120000, now: () => t });
  const { code } = pc.mint();
  t += 120001;
  expect(pc.take(code)).toBe(false);
});

test('the store is bounded: minting past max evicts the oldest', () => {
  const pc = createPairingCodes({ max: 4 });
  const first = pc.mint();
  for (let i = 0; i < 4; i++) pc.mint();
  expect(pc._size()).toBe(4);
  expect(pc.take(first.code)).toBe(false);
});

test('degenerate max folds to the default bound rather than unbounding or hanging', () => {
  // Same clamp semantics as passkeyChallenges.js: 0/NaN/negative would either
  // hang the eviction loop (<= 0) or void the bound — they read as default (4).
  const pc = createPairingCodes({ max: 0 });
  for (let i = 0; i < 6; i++) pc.mint();
  expect(pc._size()).toBe(4);
});
