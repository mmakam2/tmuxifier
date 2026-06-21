import { readFile } from 'node:fs/promises';
import { test, expect } from 'vitest';

test('declares the tmuxifier logo as the browser tab icon', async () => {
  const html = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');

  expect(html).toContain('rel="icon"');
  expect(html).toContain('href="./assets/tmuxifier-logo.png"');
});
