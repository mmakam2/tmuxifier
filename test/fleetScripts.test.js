import { test, expect } from 'vitest';
import { sortScripts, isDirty, validateName } from '../src/web/fleetScripts';

const rec = (over = {}) => ({
  id: 'fs-1', name: 'apt upgrade', script: 'echo hi',
  createdAt: '2026-07-31T10:00:00.000Z', updatedAt: '2026-07-31T10:00:00.000Z', ...over,
});

test('sortScripts orders newest-updated first with an id tie-break', () => {
  const a = rec({ id: 'fs-a', name: 'a', updatedAt: '2026-07-31T10:00:00.000Z' });
  const b = rec({ id: 'fs-b', name: 'b', updatedAt: '2026-07-31T12:00:00.000Z' });
  const c = rec({ id: 'fs-c', name: 'c', updatedAt: '2026-07-31T10:00:00.000Z' });
  expect(sortScripts([a, b, c]).map((s) => s.id)).toEqual(['fs-b', 'fs-a', 'fs-c']);
  // Pure: the input array is not reordered in place.
  expect([a, b, c].map((s) => s.id)).toEqual(['fs-a', 'fs-b', 'fs-c']);
});

test('isDirty on the unnamed draft is "there is text in the buffer"', () => {
  expect(isDirty(null, '', '', '')).toBe(false);
  expect(isDirty(null, '   \n ', '', '')).toBe(false);
  expect(isDirty(null, 'echo hi', '', '')).toBe(true);
});

test('isDirty on a selected script compares body, name and description', () => {
  const s = rec({ description: 'note' });
  expect(isDirty(s, 'echo hi', 'apt upgrade', 'note')).toBe(false);
  expect(isDirty(s, 'echo changed', 'apt upgrade', 'note')).toBe(true);
  expect(isDirty(s, 'echo hi', 'renamed', 'note')).toBe(true);
  expect(isDirty(s, 'echo hi', 'apt upgrade', 'other note')).toBe(true);
  // Surrounding whitespace on name/description is not a change — the store
  // trims both, so a stray space must not light the dirty marker forever.
  expect(isDirty(s, 'echo hi', '  apt upgrade  ', ' note ')).toBe(false);
  // A script with no description compares against ''.
  expect(isDirty(rec(), 'echo hi', 'apt upgrade', '')).toBe(false);
  expect(isDirty(rec(), 'echo hi', 'apt upgrade', 'added')).toBe(true);
});

test('validateName rejects blank, over-long and duplicate names', () => {
  const existing = [rec({ id: 'fs-1', name: 'apt upgrade' }), rec({ id: 'fs-2', name: 'docker prune' })];
  expect(validateName('deploy', existing)).toBeNull();
  expect(validateName('   ', existing)).toMatch(/name/i);
  expect(validateName('x'.repeat(81), existing)).toMatch(/80/);
  expect(validateName('APT Upgrade', existing)).toMatch(/already exists/);
  // Re-saving a record under its own name is fine.
  expect(validateName('apt upgrade', existing, 'fs-1')).toBeNull();
  expect(validateName('docker prune', existing, 'fs-1')).toMatch(/already exists/);
});
