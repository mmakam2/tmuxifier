import { test, expect } from 'vitest';
import { createInteractiveLauncher } from '../src/web/interactiveLauncher.ts';

function fakeTerm() {
  return { disposed: 0, dispose() { this.disposed += 1; } };
}

test('a second launch while a session is active is refused (no duplicate terminals)', () => {
  const l = createInteractiveLauncher();
  let opens = 0;
  const t = fakeTerm();
  const first = l.launch(() => { opens += 1; return t; });
  const second = l.launch(() => { opens += 1; return fakeTerm(); });
  expect(opens).toBe(1);
  expect(second).toBe(first);
  expect(l.active()).toBe(true);
});

test('stop disposes the live session and allows a fresh launch', () => {
  const l = createInteractiveLauncher();
  const t1 = fakeTerm();
  l.launch(() => t1);
  l.stop();
  expect(t1.disposed).toBe(1);
  expect(l.active()).toBe(false);
  const t2 = fakeTerm();
  expect(l.launch(() => t2)).toBe(t2);
});

test('done marks the session over without disposing (its own onComplete already cleaned up)', () => {
  const l = createInteractiveLauncher();
  const t = fakeTerm();
  l.launch(() => t);
  l.done();
  expect(t.disposed).toBe(0);
  expect(l.active()).toBe(false);
  l.stop(); // after done, stop must be a no-op on the old term
  expect(t.disposed).toBe(0);
});
