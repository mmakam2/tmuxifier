import { test, expect } from 'vitest';
import { mapWithConcurrency } from '../src/server/concurrency.js';

test('preserves input order in results regardless of completion order', async () => {
  // Earlier items finish later, so a naive race would reorder them.
  const items = [30, 20, 10, 5];
  const out = await mapWithConcurrency(items, 2, async (n) => {
    await new Promise((r) => setTimeout(r, n));
    return n * 10;
  });
  expect(out).toEqual([300, 200, 100, 50]);
});

test('never runs more than the limit concurrently', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i;
  });
  expect(peak).toBe(3);
});

test('processes every item even when the limit exceeds the item count', async () => {
  const out = await mapWithConcurrency([1, 2, 3], 10, async (n) => n + 1);
  expect(out).toEqual([2, 3, 4]);
});

test('empty input returns an empty array and never calls the worker', async () => {
  let called = 0;
  const out = await mapWithConcurrency([], 4, async () => { called++; });
  expect(out).toEqual([]);
  expect(called).toBe(0);
});
