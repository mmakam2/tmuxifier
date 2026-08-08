// test/themes.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, DEFAULT_THEME_ID, normalizeThemeId } from '../src/web/themes.ts';

test('manifest: instrument first, ids unique and slug-valid, labels present', () => {
  expect(THEMES[0].id).toBe(DEFAULT_THEME_ID);
  const ids = THEMES.map((t) => t.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const t of THEMES) {
    expect(t.id).toMatch(/^[a-z0-9-]{1,32}$/);
    expect(t.label.length).toBeGreaterThan(0);
    expect(t.description.length).toBeGreaterThan(0);
  }
});

test('normalizeThemeId: known ids pass, everything else falls back to the default', () => {
  expect(normalizeThemeId('original')).toBe('original');
  expect(normalizeThemeId('instrument')).toBe('instrument');
  expect(normalizeThemeId('never-heard-of-it')).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(null)).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(undefined)).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(42)).toBe(DEFAULT_THEME_ID);
});

test('manifest and themes/ dir agree: one CSS file per non-default theme', () => {
  // The lock-together pattern (test/provisionTools.test.js): the picker can
  // never offer a theme whose CSS is missing, or ship an orphan CSS file.
  const dir = path.join(process.cwd(), 'src/web/themes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4)) : [];
  const nonDefault = THEMES.slice(1).map((t) => t.id);
  expect(files.sort()).toEqual(nonDefault.sort());
});
