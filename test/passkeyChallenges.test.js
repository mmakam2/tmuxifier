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
