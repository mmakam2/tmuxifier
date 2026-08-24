import { test, expect } from 'vitest';
import { chooseDuplicateSession } from '../src/web/duplicateSession.ts';

test('adopts the first live session no pane shows, in snapshot order', () => {
  expect(chooseDuplicateSession('web', ['web', 'dev', 'ops'], ['web'])).toBe('dev');
  expect(chooseDuplicateSession('web', ['web', 'dev', 'ops'], ['web', 'dev'])).toBe('ops');
});

test('skips unswitchable names instead of dead-ending the attach', () => {
  expect(chooseDuplicateSession('web', ['web', 'my session', 'ops'], ['web'])).toBe('ops');
});

test('creates <configured>-N only when nothing is adoptable', () => {
  expect(chooseDuplicateSession('web', ['web'], ['web'])).toBe('web-2');
  expect(chooseDuplicateSession('web', ['web', 'web-2'], ['web', 'web-2'])).toBe('web-3');
});

test('the shown set guards two quick drops against a stale snapshot', () => {
  // web-2 is not live yet (created lazily by the first duplicate's attach) but
  // a pane already claims it: the second duplicate must not collide.
  expect(chooseDuplicateSession('web', ['web'], ['web', 'web-2'])).toBe('web-3');
});

test('truncates the base so the candidate stays within 64 chars', () => {
  const long = 'a'.repeat(64);
  const out = chooseDuplicateSession(long, [long], [long]);
  expect(out).toBe('a'.repeat(62) + '-2');
  expect(out.length).toBe(64);
});

test('adopting the configured session itself is legal when no pane shows it', () => {
  expect(chooseDuplicateSession('web', ['web', 'dev'], ['dev'])).toBe('web');
});
