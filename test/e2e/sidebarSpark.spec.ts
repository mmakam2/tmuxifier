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

// A graph needs two *plotted* samples, and a box's first sample carries no
// metrics, so a freshly started e2e server can have a series too short to draw
// even with the feature broken. "No graph" is only evidence once the series the
// page paints from is long enough to draw one.
type Series = Record<string, { cpuPct?: number | null }[]>;
const plotted = (samples: Series[string] | undefined) => (samples ?? []).filter((s) => s.cpuPct != null).length;

async function localhostId(page: Page): Promise<string> {
  const id = await page.locator('.box', { hasText: 'localhost' }).first().getAttribute('data-id');
  expect(id).toBeTruthy();
  return id!;
}

// Wait until the server holds >= 2 plotted samples for the box (raw length is not
// enough), reload, and wait for the page's own boot series fetch to come back
// carrying them. Returns with the rows painted from that series, so a
// `toHaveCount(0)` after it cannot pass merely because the series had not
// arrived yet. The settle tick lets the page apply the response; if it ever
// fell short the assertions below would only be as weak as before, never flaky.
async function reloadWithPlottedSeries(page: Page, id: string) {
  await expect.poll(async () => {
    const series: Series = await (await page.request.get('/api/health/series')).json();
    return plotted(series[id]);
  }, { timeout: 30000, message: 'the e2e box never produced two plotted samples' }).toBeGreaterThanOrEqual(2);

  // The boot fetch has no ?box=, which is how a nudged-tab refresh is told apart.
  const loaded = page.waitForResponse((r) => {
    const u = new URL(r.url());
    return u.pathname === '/api/health/series' && !u.searchParams.has('box') && r.ok();
  });
  await page.reload();
  const series: Series = await (await loaded).json();
  expect(plotted(series[id])).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => new Promise<void>((done) => setTimeout(done, 100)));
}

test('default is off: no graph, no gap, percentages stay', async ({ page }) => {
  await login(page);
  const stored = await (await page.request.get('/api/ui-settings')).json();
  expect(stored.sidebarSpark).toBe(false);

  // Stored off + a series long enough to draw + a fresh load = still no graph.
  await reloadWithPlottedSeries(page, await localhostId(page));
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

  await reloadWithPlottedSeries(page, await localhostId(page));
  await expect(page.locator('.box .spark-svg')).toHaveCount(0);
  const stored = await (await page.request.get('/api/ui-settings')).json();
  expect(stored.sidebarSpark).toBe(false);
});

// The tint names the graphed metric and is the one thing the toggle must give
// back exactly: off while on mem, then on, restores spark-mem (not a reset to
// cpu). The metric lives in this context's localStorage, so it costs the shared
// server nothing.
test('turning the graph off and on again restores the metric the operator had picked', async ({ page }) => {
  await login(page);
  await setSparkFromUi(page, true);
  await expect(page.locator('#boxes')).toHaveClass(/spark-cpu/);

  // Nothing to click until two samples draw a graph.
  await expect(page.locator('.spark .spark-svg path').first()).toHaveAttribute('d', /M/, { timeout: 30000 });
  await page.locator('.spark .spark-svg').first().click();
  await expect(page.locator('#boxes')).toHaveClass(/spark-mem/);

  await setSparkFromUi(page, false);
  await expect(page.locator('#boxes')).not.toHaveClass(/spark-(cpu|mem|disk)/);

  await setSparkFromUi(page, true);
  await expect(page.locator('#boxes')).toHaveClass(/spark-mem/);
  await expect(page.locator('#boxes')).not.toHaveClass(/spark-cpu/);
});

test('phone width keeps the off state collapsed', async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // The phone rule gives .spark padding; a display:none element ignores it, so
  // the empty button must still not take a row's height.
  const display = await page.evaluate(() => getComputedStyle(document.querySelector('.box .spark')!).display);
  expect(display).toBe('none');
});
