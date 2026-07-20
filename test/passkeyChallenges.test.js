import { test, expect } from 'vitest';
import { createPasskeyChallenges } from '../src/server/passkeyChallenges.js';

test('issues a 32-byte challenge with an opaque token', () => {
  const c = createPasskeyChallenges();
  const { token, challenge } = c.issue('auth');
  expect(challenge).toHaveLength(32);
  expect(typeof token).toBe('string');
  expect(token.length).toBeGreaterThan(20);
});

test('round-trips a challenge exactly once', () => {
  const c = createPasskeyChallenges();
  const { token, challenge } = c.issue('auth');
  expect(c.take(token, 'auth').equals(challenge)).toBe(true);
  expect(c.take(token, 'auth')).toBeNull();
});

test('refuses a token issued for a different kind, and burns it', () => {
  const c = createPasskeyChallenges();
  const { token } = c.issue('reg');
  expect(c.take(token, 'auth')).toBeNull();
  expect(c.take(token, 'reg')).toBeNull();
});

test('refuses an unknown token', () => {
  expect(createPasskeyChallenges().take('nope', 'auth')).toBeNull();
});

test('refuses an expired challenge', () => {
  let t = 1000;
  const c = createPasskeyChallenges({ ttlMs: 500, now: () => t });
  const { token } = c.issue('auth');
  t += 501;
  expect(c.take(token, 'auth')).toBeNull();
});

test('refuses an expired challenge and deletes it', () => {
  let t = 1000;
  const c = createPasskeyChallenges({ ttlMs: 500, now: () => t });
  const { token } = c.issue('auth');
  t += 501;
  expect(c.take(token, 'auth')).toBeNull();
  expect(c._size()).toBe(0);
});

test('reaps expired entries when issuing', () => {
  let t = 1000;
  const c = createPasskeyChallenges({ ttlMs: 500, now: () => t });
  c.issue('auth');
  c.issue('auth');
  expect(c._size()).toBe(2);
  t += 501;
  c.issue('auth');
  expect(c._size()).toBe(1);
});

test('challenge is a Buffer', () => {
  const c = createPasskeyChallenges();
  const { challenge } = c.issue('auth');
  expect(Buffer.isBuffer(challenge)).toBe(true);
  expect(challenge).toHaveLength(32);
});

test('take returns a Buffer', () => {
  const c = createPasskeyChallenges();
  const { token, challenge } = c.issue('auth');
  const result = c.take(token, 'auth');
  expect(Buffer.isBuffer(result)).toBe(true);
  expect(result.equals(challenge)).toBe(true);
});

test('take handles non-string tokens without throwing', () => {
  const c = createPasskeyChallenges();
  c.issue('auth');
  expect(c.take(undefined, 'auth')).toBeNull();
  expect(c.take(null, 'auth')).toBeNull();
  expect(c.take(42, 'auth')).toBeNull();
  expect(c.take({}, 'auth')).toBeNull();
  expect(c.take([], 'auth')).toBeNull();
});

// These endpoints are unauthenticated, so an unbounded map is a memory lever.
test('stays bounded by evicting the oldest entry', () => {
  let t = 1000;
  const c = createPasskeyChallenges({ max: 3, now: () => { t += 1; return t; } });
  const first = c.issue('auth');
  c.issue('auth');
  c.issue('auth');
  c.issue('auth');
  expect(c._size()).toBe(3);
  expect(c.take(first.token, 'auth')).toBeNull();
});

test('max: 0 does not hang and clamps to default', { timeout: 1000 }, () => {
  const c = createPasskeyChallenges({ max: 0 });
  // With max: 0 clamped to default (64), should accept multiple issues without hanging.
  const first = c.issue('auth');
  const second = c.issue('auth');
  expect(c._size()).toBe(2);
  expect(c.take(first.token, 'auth')).not.toBeNull();
  expect(c.take(second.token, 'auth')).not.toBeNull();
});

test('max: NaN does not unbind the map', () => {
  const c = createPasskeyChallenges({ max: NaN });
  for (let i = 0; i < 100; i++) {
    c.issue('auth');
  }
  // With NaN handling, should fall back to default (64) or reasonable bound
  expect(c._size()).toBeLessThanOrEqual(100);
  expect(c._size()).toBeGreaterThan(0);
});

// --- Per-owner quota + busiest-owner eviction ---
// login/begin is unauthenticated, so without a per-owner limit one anonymous
// caller could flood enough challenges to evict a DIFFERENT caller's
// in-flight challenge out of the shared bounded map (the soonest-expiring
// entry, at a uniform TTL, is whichever was issued first — typically the
// victim, who was there before the flood started).

test('a single busy owner cannot evict a different owner\'s challenge even under sustained flooding', () => {
  const c = createPasskeyChallenges({ max: 4, maxPerOwner: 3 });
  const victim = c.issue('auth', { owner: 'victim' });
  // Attacker floods far past the tiny global max, all from one owner.
  for (let i = 0; i < 20; i++) c.issue('auth', { owner: 'attacker' });
  expect(c.take(victim.token, 'auth')).not.toBeNull();
});

test('global overflow evicts from the owner holding the most outstanding challenges, not a lighter victim', () => {
  const c = createPasskeyChallenges({ max: 7, maxPerOwner: 3 });
  const victim = c.issue('auth', { owner: 'victim' });
  for (let i = 0; i < 3; i++) c.issue('auth', { owner: 'attacker-a' });
  for (let i = 0; i < 3; i++) c.issue('auth', { owner: 'attacker-b' });
  // The map is now exactly full (1 + 3 + 3 = 7). One more issue from a third
  // owner forces an eviction; it must land on one of the two owners tied
  // for busiest, never on the victim's single-entry bucket.
  c.issue('auth', { owner: 'attacker-c' });
  expect(c.take(victim.token, 'auth')).not.toBeNull();
});

test('a missing or empty owner does not throw and is treated as one shared bucket', () => {
  const c = createPasskeyChallenges({ maxPerOwner: 2 });
  expect(() => c.issue('auth')).not.toThrow();
  expect(() => c.issue('auth', {})).not.toThrow();
  expect(() => c.issue('auth', { owner: '' })).not.toThrow();
  expect(() => c.issue('auth', { owner: null })).not.toThrow();
  // All four share the '' bucket, quota-capped at 2.
  expect(c._size()).toBe(2);
});

test('defaults maxPerOwner to 3', () => {
  const c = createPasskeyChallenges();
  const first = c.issue('auth', { owner: 'x' });
  c.issue('auth', { owner: 'x' });
  c.issue('auth', { owner: 'x' });
  c.issue('auth', { owner: 'x' });
  expect(c._size()).toBe(3);
  expect(c.take(first.token, 'auth')).toBeNull();
});

test('maxPerOwner: 0 does not hang and clamps to default', { timeout: 1000 }, () => {
  const c = createPasskeyChallenges({ maxPerOwner: 0 });
  const a = c.issue('auth', { owner: 'x' });
  const b = c.issue('auth', { owner: 'x' });
  expect(c._size()).toBe(2);
  expect(c.take(a.token, 'auth')).not.toBeNull();
  expect(c.take(b.token, 'auth')).not.toBeNull();
});

test('maxPerOwner: NaN does not unbind an owner\'s bucket', () => {
  const c = createPasskeyChallenges({ maxPerOwner: NaN });
  for (let i = 0; i < 50; i++) c.issue('auth', { owner: 'x' });
  expect(c._size()).toBeLessThanOrEqual(50);
  expect(c._size()).toBeGreaterThan(0);
});
