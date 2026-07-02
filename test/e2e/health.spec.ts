import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('rows grow a sparkline; a down transition lands in the Events panel and clears the badge', async ({ page }) => {
  await login(page);

  // The server samples every status poll (2s in the e2e env); the client
  // refetches the series on load, so reload until two samples produce a path.
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.spark .spark-svg path').first()).toHaveAttribute('d', /M/, { timeout: 4000 });
  }).toPass({ timeout: 45000 });

  // Clicking the sparkline cycles the metric and highlights the meta figure it
  // graphs (cpu -> mem), without opening the box terminal.
  await expect(page.locator('#boxes')).toHaveClass(/spark-cpu/);
  await page.locator('.spark .spark-svg').first().click();
  await expect(page.locator('#boxes')).toHaveClass(/spark-mem/);
  await expect(page.locator('.box-meta .metric-mem').first()).toBeVisible();
  await expect(page.locator('.term')).toHaveCount(0);
  await page.locator('.spark .spark-svg').first().click(); // -> disk
  await page.locator('.spark .spark-svg').first().click(); // -> back to cpu

  // Force a reachability edge: point the box at a dead port via the API (the
  // page's session cookie rides along), then reload so the client refetches.
  const id = await page.locator('.box', { hasText: 'localhost' }).first().getAttribute('data-id');
  expect(id).toBeTruthy();
  const patched = await page.request.patch(`/api/boxes/${id}`, { data: { port: 1 } });
  expect(patched.ok()).toBeTruthy();
  try {
    await expect(async () => {
      await page.reload();
      await expect(page.locator('#events-badge')).toBeVisible({ timeout: 6000 });
    }).toPass({ timeout: 30000 });

    await page.locator('#events').click();
    await expect(page.locator('#events-panel .event-row.crit .event-text').first())
      .toContainText('localhost — unreachable', { timeout: 10000 });
    // Opening the panel marks everything seen — the badge must clear. The badge
    // is in-app only; the Notification API is never touched.
    await expect(page.locator('#events-badge')).toBeHidden();
  } finally {
    // Restore the box for later specs: default port back, backoff cleared.
    await page.request.patch(`/api/boxes/${id}`, { data: { port: null } });
    await page.request.post(`/api/boxes/${id}/reconnect`);
  }
});
