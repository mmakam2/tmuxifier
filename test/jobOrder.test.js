import { test, expect } from 'vitest';
import { newestFirst } from '../src/server/jobOrder.js';

// The job managers sort newest-first. The comparator must be a valid total
// order (the old inline version returned -1 for equal timestamps, which is
// only deterministic thanks to V8's stable sort).
test('newestFirst orders by createdAt descending', () => {
  const a = { id: 'a', createdAt: '2026-07-18T00:00:01Z' };
  const b = { id: 'b', createdAt: '2026-07-18T00:00:02Z' };
  expect([a, b].sort(newestFirst).map((j) => j.id)).toEqual(['b', 'a']);
});

test('equal timestamps tie-break by id, and the comparator is antisymmetric', () => {
  const a = { id: 'a', createdAt: '2026-07-18T00:00:01Z' };
  const b = { id: 'b', createdAt: '2026-07-18T00:00:01Z' };
  expect(newestFirst(a, a)).toBe(0);
  expect(newestFirst(a, b)).toBe(-newestFirst(b, a));
  expect(newestFirst(a, b)).not.toBe(0);
});
