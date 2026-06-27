import { test, expect } from 'vitest';
import { buildFontFamily, clampFontSize, BUNDLED_FONT_STACK, DEFAULT_TERM_FONT_SIZE } from '../src/web/termFont.ts';

test('buildFontFamily prepends a quoted custom family onto the bundled stack', () => {
  expect(buildFontFamily('Fira Code')).toBe(`'Fira Code', ${BUNDLED_FONT_STACK}`);
  expect(buildFontFamily('  JetBrains Mono  ')).toBe(`'JetBrains Mono', ${BUNDLED_FONT_STACK}`);
});

test('buildFontFamily returns the bundled stack unchanged when no/empty font', () => {
  expect(buildFontFamily(null)).toBe(BUNDLED_FONT_STACK);
  expect(buildFontFamily(undefined)).toBe(BUNDLED_FONT_STACK);
  expect(buildFontFamily('')).toBe(BUNDLED_FONT_STACK);
  expect(buildFontFamily('   ')).toBe(BUNDLED_FONT_STACK);
});

test('buildFontFamily refuses unsafe names (defense in depth) and keeps the bundled stack', () => {
  expect(buildFontFamily("Foo'; }")).toBe(BUNDLED_FONT_STACK);   // CSS injection
  expect(buildFontFamily('Foo, Bar')).toBe(BUNDLED_FONT_STACK);  // comma = multiple families
  expect(buildFontFamily('Foo"')).toBe(BUNDLED_FONT_STACK);      // quote
  expect(buildFontFamily('Foo<script>')).toBe(BUNDLED_FONT_STACK);
});

test('the bundled stack leads with MesloLGMDZ and keeps Meslo LGS + JuliaMono fallback', () => {
  expect(BUNDLED_FONT_STACK.startsWith("'MesloLGMDZ Nerd Font', ")).toBe(true); // bundled default
  expect(BUNDLED_FONT_STACK).toContain("'MesloLGSDZ Nerd Font'");               // kept as fallback
  expect(BUNDLED_FONT_STACK).toContain("'JuliaMono'");                          // Claude Code glyphs
  expect(BUNDLED_FONT_STACK.endsWith('monospace')).toBe(true);
});

test('clampFontSize keeps 6..32 and falls back to the default otherwise', () => {
  expect(clampFontSize(14)).toBe(14);
  expect(clampFontSize(6)).toBe(6);
  expect(clampFontSize(32)).toBe(32);
  expect(clampFontSize(4)).toBe(DEFAULT_TERM_FONT_SIZE);
  expect(clampFontSize(99)).toBe(DEFAULT_TERM_FONT_SIZE);
  expect(clampFontSize(NaN)).toBe(DEFAULT_TERM_FONT_SIZE);
  expect(clampFontSize(undefined)).toBe(DEFAULT_TERM_FONT_SIZE);
});
