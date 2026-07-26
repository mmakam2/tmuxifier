import { test, expect } from '@playwright/test';

// Split terminals: dock/focus/resize/persistence mechanics. localhost is the
// only real sshd-backed box; db-primary and untagged-worker are unreachable
// rows whose terminals just show connect-retry text — pane mechanics are what
// is under test, so that is fine.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('dock a second box, type into the focused pane, resize, and survive reload', async ({ page }) => {
  await login(page);

  // Open localhost full-stage, then dock db-primary beside it via the keyboard path.
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await expect(page.locator('.pane-nameplate').first()).toHaveText(/localhost/i);

  // Focus the localhost pane and prove keystrokes land there. Wait for the
  // remote prompt first — input typed while the WS connects is dropped.
  const firstPane = page.locator('.stage-pane').first();
  await firstPane.click();
  await expect(firstPane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  await page.keyboard.type('echo SPLIT_E2E_MARKER');
  await page.keyboard.press('Enter');
  await expect(firstPane).toContainText('SPLIT_E2E_MARKER', { timeout: 15000 });

  // Divider: keyboard resize follows the ARIA splitter pattern.
  const divider = page.locator('.stage-divider');
  await expect(divider).toHaveAttribute('aria-valuenow', '50');
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '55');

  // The split (panes + ratio) survives a reload.
  await page.reload();
  await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 10000 });
  await expect(page.locator('.stage-divider')).toHaveAttribute('aria-valuenow', '55');

  // Undock returns to a single full pane.
  await page.locator('.stage-pane').nth(1).hover();
  await page.getByRole('button', { name: 'Undock db-primary' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
});

test('plain-clicking a third box replaces the focused pane', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  // db-primary is focused (it was just docked); clicking untagged-worker replaces it.
  await page.locator('.box .name', { hasText: 'untagged-worker' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await expect(page.locator('.pane-nameplate', { hasText: 'untagged-worker' })).toBeVisible();
  await expect(page.locator('.pane-nameplate', { hasText: 'db-primary' })).toHaveCount(0);
});
