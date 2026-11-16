import { test, expect, beforeEach } from 'vitest';
import { sidebarSparkOn, setSidebarSpark, onSidebarSparkChange, sparkListClass } from '../src/web/sidebarSpark.ts';

beforeEach(() => setSidebarSpark(false)); // module state is shared across tests

test('is off until set', () => {
  expect(sidebarSparkOn()).toBe(false);
  setSidebarSpark(true);
  expect(sidebarSparkOn()).toBe(true);
});

test('listeners fire once per change, not on a repeat value, and can unsubscribe', () => {
  let n = 0;
  const off = onSidebarSparkChange(() => { n += 1; });
  setSidebarSpark(true);
  setSidebarSpark(true);
  expect(n).toBe(1);
  setSidebarSpark(false);
  expect(n).toBe(2);
  off();
  setSidebarSpark(true);
  expect(n).toBe(2);
});

test('the list tint class names the metric, and is absent while off', () => {
  expect(sparkListClass(true, 'cpuPct')).toBe('spark-cpu');
  expect(sparkListClass(true, 'memPct')).toBe('spark-mem');
  expect(sparkListClass(true, 'diskPct')).toBe('spark-disk');
  for (const m of ['cpuPct', 'memPct', 'diskPct']) expect(sparkListClass(false, m)).toBeNull();
});
