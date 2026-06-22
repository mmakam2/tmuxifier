import { test, expect } from 'vitest';
import { dotClassFor, dotTitleFor } from '../src/web/statusDot.ts';

test('dotClassFor: unknown status is gray', () => {
  expect(dotClassFor(undefined)).toBe('gray');
});

test('dotClassFor: reachable with tmux is green', () => {
  expect(dotClassFor({ reachable: true, tmux: true })).toBe('green');
});

test('dotClassFor: reachable without tmux is amber', () => {
  expect(dotClassFor({ reachable: true, tmux: false })).toBe('amber');
});

test('dotClassFor: unreachable is red', () => {
  expect(dotClassFor({ reachable: false })).toBe('red');
});

test('dotClassFor: needsAuth wins over reachable=false (distinct from a dead box)', () => {
  expect(dotClassFor({ reachable: false, needsAuth: true })).toBe('auth');
});

test('dotTitleFor: needsAuth explains how to recover', () => {
  expect(dotTitleFor({ reachable: false, needsAuth: true })).toMatch(/reconnect/i);
});

test('dotTitleFor: paused unreachable explains the 5m retry and how to force one', () => {
  const title = dotTitleFor({ reachable: false, paused: true });
  expect(title).toMatch(/5m/);
  expect(title).toMatch(/retry/i);
});

test('dotTitleFor: plain (non-paused) unreachable stays terse', () => {
  expect(dotTitleFor({ reachable: false })).toBe('Unreachable');
});
