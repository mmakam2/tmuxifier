import { test, expect } from '@playwright/test';

test('login, open a box terminal, reload, and reattach to the same session', async ({ page }) => {
  // Login
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  // Wait for dashboard with seeded box
  await expect(page.locator('.box .name')).toBeVisible({ timeout: 10000 });

  // Open the box terminal
  await page.locator('.box .name').first().click();
  await expect(page.locator('.term, .xterm').first()).toBeVisible({ timeout: 10000 });

  // Type a unique marker into the shell
  await page.keyboard.type('echo TMUXIFIER_E2E_MARKER\n');
  await expect(page.locator('.xterm-rows').first()).toContainText('TMUXIFIER_E2E_MARKER', { timeout: 10000 });

  // Reload — auth cookie persists so dashboard comes back; tmux session must survive
  await page.reload();
  await expect(page.locator('.box .name')).toBeVisible({ timeout: 10000 });
  await page.locator('.box .name').first().click();

  // Marker must still be visible proving reattach to the same tmux session
  await expect(page.locator('.xterm-rows').first()).toContainText('TMUXIFIER_E2E_MARKER', { timeout: 10000 });
});

test('sidebar can collapse and remembers state after reload', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const layout = page.locator('.layout');
  const sidebar = page.locator('.sidebar');
  const sidebarWidth = async () => (await sidebar.boundingBox())?.width ?? 0;
  await expect(layout).toBeVisible({ timeout: 10000 });
  await expect(layout).not.toHaveClass(/sidebar-collapsed/);

  expect(await sidebarWidth()).toBeGreaterThanOrEqual(315);

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(layout).toHaveClass(/sidebar-collapsed/);

  await expect.poll(sidebarWidth).toBeLessThanOrEqual(64);
  await expect(page.locator('.brand img')).toBeVisible();

  await page.reload();
  await expect(page.locator('.layout')).toHaveClass(/sidebar-collapsed/, { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await expect(page.locator('.brand img')).toBeVisible();

  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(page.locator('.layout')).not.toHaveClass(/sidebar-collapsed/);
});
