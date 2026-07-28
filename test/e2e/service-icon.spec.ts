import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Browser-level coverage for service tile icons, and it exists because the
// node-only suite structurally cannot catch this class of defect: every server
// test passed while the icon never rendered. The first bug it caught was an
// <img> built with both `loading="lazy"` and `hidden` — display:none gives the
// element no layout box, so the browser never decides it is near the viewport,
// never fetches, never fires `load`, and so never unhides. A deadlock visible
// only in a real browser.

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Its own fixture rather than a catalog entry: `npm run fetch-icons` is a
// deliberate one-time step, so a fresh clone has an empty vendor/icons/ and a
// test leaning on a real slug would fail for the wrong reason.
const SLUG = 'e2e-icon-fixture';
const iconFile = path.join(repoRoot, 'vendor', 'icons', `${SLUG}.svg`);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#ffb000"/></svg>';

test.beforeAll(async () => {
  await fs.mkdir(path.dirname(iconFile), { recursive: true });
  await fs.writeFile(iconFile, SVG);
});

test.afterAll(async () => {
  await fs.rm(iconFile, { force: true });
});

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('a service tile renders its resolved icon, and a service with none renders no icon', async ({ page }) => {
  await login(page);

  // Port 1 refuses immediately, so the best-effort favicon scrape the POST
  // kicks off cannot leave a request hanging past the test.
  const withIcon = await page.request.post('/api/services', {
    data: { name: 'Icon Fixture', url: 'http://127.0.0.1:1/', icon: SLUG, check: { kind: 'none' } },
  });
  expect(withIcon.ok()).toBeTruthy();
  const iconSvc = await withIcon.json();

  const noIcon = await page.request.post('/api/services', {
    data: { name: 'No Icon', url: 'http://127.0.0.1:1/', icon: 'none', check: { kind: 'none' } },
  });
  expect(noIcon.ok()).toBeTruthy();
  const bareSvc = await noIcon.json();

  try {
    await page.reload();
    const tile = page.locator('.dash-tile', { hasText: 'Icon Fixture' });
    await expect(tile).toBeVisible({ timeout: 10000 });

    // toBeVisible alone would pass on an <img> that is displayed but broken, so
    // naturalWidth is the assertion that actually proves the bytes arrived.
    const icon = tile.locator('.dash-icon');
    await expect(icon).toBeVisible({ timeout: 10000 });
    await expect
      .poll(async () => icon.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10000 })
      .toBeGreaterThan(0);

    // 'none' is a suppression, so the element stays in the DOM but hidden.
    const bare = page.locator('.dash-tile', { hasText: 'No Icon' }).locator('.dash-icon');
    await expect(bare).toBeHidden();
  } finally {
    await page.request.delete(`/api/services/${iconSvc.id}`);
    await page.request.delete(`/api/services/${bareSvc.id}`);
  }
});
