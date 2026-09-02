import { readFile } from 'node:fs/promises';
import { test, expect } from 'vitest';
import { DEFAULT_THEME_ID, ROOT_THEME_ID } from '../src/web/themes.ts';

// The static <link rel=icon> is what the tab shows before the bundle's
// applyTheme re-points it, so it must be the DEFAULT theme's mark: a fresh
// browser would otherwise flash another theme's icon on every cold load. The
// root theme's mark is the unsuffixed tmuxifier-logo.png; every other theme's
// is tmuxifier-logo-<id>.png (theme.ts LOGOS).
test('declares the default theme\'s logo as the browser tab icon', async () => {
  const html = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const expected = DEFAULT_THEME_ID === ROOT_THEME_ID ? 'tmuxifier-logo.png' : `tmuxifier-logo-${DEFAULT_THEME_ID}.png`;

  expect(html).toContain('rel="icon"');
  expect(html).toContain(`href="./assets/${expected}"`);
});
