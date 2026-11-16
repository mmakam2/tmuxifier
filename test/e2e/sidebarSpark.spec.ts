import { test, expect, type Page } from '@playwright/test';

// The sidebar sparkline is optional and OFF by default (Settings → Appearance,
// stored server-side in data/ui-settings.json). Off: no graph, no gap, the
// meta-line percentages stay. On: today's behavior, including click-to-cycle.
//
// Suite hygiene: the setting is server-global and the e2e server is shared by
// every spec (workers: 1), so this file ends with it back OFF (the default).

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

// Belt and braces, as in theme.spec.ts: covers an assertion failing before the
// in-test restore. Silent: it must never turn a run red on its own.
test.afterEach(async ({ page }) => {
  try {
    await page.request.post('/api/login', { data: { password: 'e2e' } });
    await page.request.patch('/api/ui-settings', { data: { sidebarSpark: false } });
  } catch { /* the assertions in the test are the real proof */ }
});

// The checkbox applies locally and PATCHes fire-and-forget, so waiting for the
// response is load-bearing: a reload right after would race the request whose
// effect it asserts.
async function setSparkFromUi(page: Page, on: boolean) {
  await page.click('#settings');
  await page.click('.pve-tabs button:has-text("Appearance")');
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/ui-settings') && r.request().method() === 'PATCH' && r.ok(),
    { timeout: 10000 },
  );
  await page.locator('.appearance-row:has-text("usage graph") input[type="checkbox"]').setChecked(on);
  await saved;
  await page.keyboard.press('Escape'); // close the settings modal
}

test('default is off: no graph, no gap, percentages stay', async ({ page }) => {
  await login(page);
  const stored = await (await page.request.get('/api/ui-settings')).json();
  expect(stored.sidebarSpark).toBe(false);

  await expect(page.locator('.box .spark-svg')).toHaveCount(0);
  await expect(page.locator('#boxes')).not.toHaveClass(/spark-(cpu|mem|disk)/);
  const spark = page.locator('.box .spark').first();
  await expect(spark).toBeHidden();
  expect(await spark.evaluate((e) => getComputedStyle(e).display)).toBe('none');
  await expect(page.locator('.box-meta .metric-cpu').first()).toBeVisible({ timeout: 15000 });
});

test('the checkbox applies live, persists across reload, and turns off again', async ({ page }) => {
  await login(page);
  await setSparkFromUi(page, true);

  // The tint class is synchronous with the toggle; the path needs two samples.
  await expect(page.locator('#boxes')).toHaveClass(/spark-cpu/);
  await expect(page.locator('.spark .spark-svg path').first()).toHaveAttribute('d', /M/, { timeout: 30000 });

  // Click-to-cycle is today's behavior and stays: cpu -> mem -> disk -> cpu.
  await page.locator('.spark .spark-svg').first().click();
  await expect(page.locator('#boxes')).toHaveClass(/spark-mem/);
  await page.locator('.spark .spark-svg').first().click();
  await page.locator('.spark .spark-svg').first().click();
  await expect(page.locator('#boxes')).toHaveClass(/spark-cpu/);

  // Persisted server-side: the first paint after a reload already has the graph.
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.spark .spark-svg path').first()).toHaveAttribute('d', /M/, { timeout: 4000 });
  }).toPass({ timeout: 45000 });

  // Off again, with no reload: graph and tint both go.
  await setSparkFromUi(page, false);
  await expect(page.locator('.box .spark-svg')).toHaveCount(0);
  await expect(page.locator('#boxes')).not.toHaveClass(/spark-(cpu|mem|disk)/);

  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.box .spark-svg')).toHaveCount(0);
  const stored = await (await page.request.get('/api/ui-settings')).json();
  expect(stored.sidebarSpark).toBe(false);
});

test('phone width keeps the off state collapsed', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // The phone rule gives .spark padding; a display:none element ignores it, so
  // the empty button must still not take a row's height.
  const display = await page.evaluate(() => getComputedStyle(document.querySelector('.box .spark')!).display);
  expect(display).toBe('none');
});
