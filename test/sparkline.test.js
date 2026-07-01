import { test, expect } from 'vitest';
import { sparkline } from '../src/web/sparkline.ts';

const S = (cpu) => ({ t: 0, up: true, cpuPct: cpu });

test('returns empty for fewer than two plotted points', () => {
  expect(sparkline([], 'cpuPct')).toBe('');
  expect(sparkline([S(10)], 'cpuPct')).toBe('');
});

test('builds a moveto+lineto path across the series', () => {
  const d = sparkline([S(0), S(50), S(100)], 'cpuPct', { w: 10, h: 10, max: 100 });
  expect(d.startsWith('M')).toBe(true);
  expect((d.match(/L/g) || []).length).toBe(2); // three points → one M, two L
});

test('gaps (missing metric) split the path into separate segments', () => {
  const d = sparkline([S(10), { t: 0, up: false }, S(20), S(30)], 'cpuPct', { w: 10, h: 10 });
  expect((d.match(/M/g) || []).length).toBe(2); // a new subpath starts after the gap
});

test('clamps values into the box', () => {
  const d = sparkline([S(-20), S(200)], 'cpuPct', { w: 10, h: 10, max: 100 });
  expect(d).not.toMatch(/-/);        // no negative coordinates
});
