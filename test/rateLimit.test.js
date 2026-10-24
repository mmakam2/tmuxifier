import { test, expect } from 'vitest';
import { createLoginRateLimiter } from '../src/server/rateLimit.js';

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

test('locks an ip out after max failures within the window', () => {
  const { now } = makeClock();
  const rl = createLoginRateLimiter({ max: 3, windowMs: 60000, now });
  expect(rl.limited('a')).toBe(false);
  rl.fail('a'); rl.fail('a');
  expect(rl.limited('a')).toBe(false);
  rl.fail('a');
  expect(rl.limited('a')).toBe(true);
});

test('the lockout expires when the window passes', () => {
  const clock = makeClock();
  const rl = createLoginRateLimiter({ max: 2, windowMs: 60000, now: clock.now });
  rl.fail('a'); rl.fail('a');
  expect(rl.limited('a')).toBe(true);
  clock.tick(60001);
  expect(rl.limited('a')).toBe(false);
  rl.fail('a'); // a new window starts counting from one
  expect(rl.limited('a')).toBe(false);
});

test('a successful login clears the ip history', () => {
  const { now } = makeClock();
  const rl = createLoginRateLimiter({ max: 2, windowMs: 60000, now });
  rl.fail('a');
  rl.succeed('a');
  rl.fail('a');
  expect(rl.limited('a')).toBe(false); // count restarted, not accumulated
});

// attempt() is the check-and-charge for handlers that await (scrypt) before
// they know the outcome: it charges in the same synchronous step as the check,
// so attempts still in flight count against the cap.
test('attempt() admits at most max in-flight attempts before any outcome is known', () => {
  const { now } = makeClock();
  const rl = createLoginRateLimiter({ max: 3, windowMs: 60000, now });
  const admitted = Array.from({ length: 10 }, () => rl.attempt('a'));
  expect(admitted).toEqual([true, true, true, false, false, false, false, false, false, false]);
  expect(rl.limited('a')).toBe(true);
});

test('attempt() counts exactly like fail() for sequential traffic', () => {
  const { now } = makeClock();
  const rl = createLoginRateLimiter({ max: 3, windowMs: 60000, now });
  rl.fail('a');
  expect(rl.attempt('a')).toBe(true);
  expect(rl.limited('a')).toBe(false);
  expect(rl.attempt('a')).toBe(true);
  expect(rl.limited('a')).toBe(true);
});

test('a success after attempt() clears the charge', () => {
  const { now } = makeClock();
  const rl = createLoginRateLimiter({ max: 2, windowMs: 60000, now });
  rl.fail('a');
  expect(rl.attempt('a')).toBe(true); // the right password at max - 1 is still admitted
  rl.succeed('a');
  expect(rl.attempt('a')).toBe(true);
  expect(rl.limited('a')).toBe(false); // count restarted, not accumulated
});

test('attempt() is refused while locked out and admitted again once the window passes', () => {
  const clock = makeClock();
  const rl = createLoginRateLimiter({ max: 2, windowMs: 60000, now: clock.now });
  rl.attempt('a'); rl.attempt('a');
  expect(rl.attempt('a')).toBe(false);
  clock.tick(60001);
  expect(rl.attempt('a')).toBe(true); // a new window starts counting from one
  expect(rl.limited('a')).toBe(false);
});

test('ips are tracked independently', () => {
  const { now } = makeClock();
  const rl = createLoginRateLimiter({ max: 2, windowMs: 60000, now });
  rl.fail('a'); rl.fail('a');
  expect(rl.limited('a')).toBe(true);
  expect(rl.limited('b')).toBe(false);
});

// The overflow path used to be `attempts.clear()` — a global reset that let an
// attacker flooding from many IPs (one IPv6 /64 is plenty) erase their own
// lockout along with everyone else's. Overflow now evicts only the entry with
// the oldest window start; a fresh lockout survives a flood of new IPs.
test('overflow evicts the oldest entry, not everyone', () => {
  const clock = makeClock();
  const rl = createLoginRateLimiter({ max: 2, windowMs: 600000, maxEntries: 3, now: clock.now });
  rl.fail('old'); clock.tick(1000);
  rl.fail('locked'); rl.fail('locked'); clock.tick(1000); // locked out, newer than 'old'
  rl.fail('c'); clock.tick(1000);
  expect(rl._size()).toBe(3);
  rl.fail('d'); // over capacity — evicts 'old', the oldest window
  expect(rl._size()).toBe(3);
  expect(rl.limited('locked')).toBe(true); // the lockout survived the overflow
});

test('the map never grows past maxEntries under an ip flood', () => {
  const clock = makeClock();
  const rl = createLoginRateLimiter({ maxEntries: 10, now: clock.now });
  for (let i = 0; i < 100; i++) { rl.fail(`ip-${i}`); clock.tick(1); }
  expect(rl._size()).toBe(10);
});
