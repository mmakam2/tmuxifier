import { test, expect } from 'vitest';
import { importSummary } from '../src/web/settingsBoxes.ts';

test('importSummary: singular vs plural box count', () => {
  expect(importSummary(1, 0)).toBe('Imported 1 box');
  expect(importSummary(3, 0)).toBe('Imported 3 boxes');
  expect(importSummary(0, 0)).toBe('Imported 0 boxes');
});

test('importSummary: the skipped clause appears only when something was skipped', () => {
  expect(importSummary(3, 1)).toBe('Imported 3 boxes, 1 skipped');
  expect(importSummary(1, 2)).toBe('Imported 1 box, 2 skipped');
  expect(importSummary(0, 4)).toBe('Imported 0 boxes, 4 skipped');
  expect(importSummary(2, 0)).toBe('Imported 2 boxes');
});
