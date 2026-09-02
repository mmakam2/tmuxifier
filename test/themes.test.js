// test/themes.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, DEFAULT_THEME_ID, ROOT_THEME_ID, normalizeThemeId } from '../src/web/themes.ts';

// Two ids, deliberately distinct since Vercel became the shipped default:
// DEFAULT_THEME_ID is what a null/unknown preference resolves to, ROOT_THEME_ID
// is the theme :root's own tokens paint with no data-theme attribute. Making
// the default a different theme moved not one token — only these two names.
test('the shipped default is Vercel; Instrument stays the :root theme', () => {
  expect(DEFAULT_THEME_ID).toBe('vercel');
  expect(ROOT_THEME_ID).toBe('instrument');
  expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  expect(THEMES.some((t) => t.id === ROOT_THEME_ID)).toBe(true);
});

test('manifest: default first, ids unique and slug-valid, labels present', () => {
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
  expect(normalizeThemeId('vercel')).toBe('vercel');
  expect(normalizeThemeId('never-heard-of-it')).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(null)).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(undefined)).toBe(DEFAULT_THEME_ID);
  expect(normalizeThemeId(42)).toBe(DEFAULT_THEME_ID);
});

test('manifest and themes/ dir agree: one CSS file per non-root theme', () => {
  // The lock-together pattern (test/provisionTools.test.js): the picker can
  // never offer a theme whose CSS is missing, or ship an orphan CSS file. Keyed
  // on the ROOT theme, not the default: Instrument is the one theme with no
  // file of its own, because :root's token block IS its stylesheet.
  const dir = path.join(process.cwd(), 'src/web/themes');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4)) : [];
  const nonRoot = THEMES.filter((t) => t.id !== ROOT_THEME_ID).map((t) => t.id);
  expect(files.sort()).toEqual(nonRoot.sort());
});

// theme-boot.js is a classic script with no imports, so it cannot read the
// manifest: it carries both ids as literals. This pins them to the manifest so
// a future default change cannot leave the pre-paint script stamping the old
// one (a fresh browser would flash the previous default on every cold load).
test('theme-boot.js literals agree with the manifest', () => {
  const boot = fs.readFileSync(path.join(process.cwd(), 'src/web/public/theme-boot.js'), 'utf8');
  const strings = [...boot.matchAll(/'([a-z0-9-]{1,32})'/g)].map((m) => m[1]).filter((s) => s !== 'tmuxifier.theme' && s !== 'data-theme');
  expect(strings, 'default id literal in theme-boot.js').toContain(DEFAULT_THEME_ID);
  expect(strings, 'root id literal in theme-boot.js').toContain(ROOT_THEME_ID);
  // Exactly those two theme ids and nothing else: a third literal would mean
  // the script grew knowledge the manifest does not have.
  const themeIds = strings.filter((s) => THEMES.some((t) => t.id === s));
  expect(new Set(themeIds)).toEqual(new Set([DEFAULT_THEME_ID, ROOT_THEME_ID]));
});
