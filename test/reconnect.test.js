import { test, expect } from 'vitest';
import { reconnectDelay } from '../src/web/reconnect.ts';

test('reconnectDelay: escalates exponentially from 1s', () => {
  expect(reconnectDelay(1)).toBe(1000);
  expect(reconnectDelay(2)).toBe(2000);
  expect(reconnectDelay(3)).toBe(4000);
  expect(reconnectDelay(4)).toBe(8000);
});

test('reconnectDelay: caps at a 5-minute floor and never exceeds it (never gives up)', () => {
  expect(reconnectDelay(20)).toBe(300000);
  expect(reconnectDelay(100)).toBe(300000);
  expect(Number.isFinite(reconnectDelay(100))).toBe(true);
});

test('reconnectDelay: is monotonically non-decreasing up to the cap', () => {
  let prev = 0;
  for (let n = 1; n <= 15; n++) {
    const d = reconnectDelay(n);
    expect(d).toBeGreaterThanOrEqual(prev);
    expect(d).toBeLessThanOrEqual(300000);
    prev = d;
  }
});

test('reconnectDelay: clamps a non-positive count to the base delay', () => {
  expect(reconnectDelay(0)).toBe(1000);
  expect(reconnectDelay(-5)).toBe(1000);
});

test('reconnectDelay: honors custom base/cap', () => {
  expect(reconnectDelay(1, { baseMs: 500, capMs: 5000 })).toBe(500);
  expect(reconnectDelay(2, { baseMs: 500, capMs: 5000 })).toBe(1000);
  expect(reconnectDelay(10, { baseMs: 500, capMs: 5000 })).toBe(5000);
});
