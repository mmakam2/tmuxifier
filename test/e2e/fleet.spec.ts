import { test, expect } from '@playwright/test';

async function loginAndWait(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('fleet command runs on a selected box and shows captured output', async ({ page }) => {
  await loginAndWait(page);

  await page.getByRole('button', { name: 'Fleet', exact: true }).click();

  // Select the localhost box (key-auth works for one-shot exec)
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();

  await page.locator('.fleet-input').fill('echo FLEET_E2E_MARKER');
  await page.locator('#fleet-run').click();

  // Confirm dialog
  await expect(page.getByRole('heading', { name: /Run on 1 box/ })).toBeVisible();
  await page.getByRole('button', { name: /^Run on 1 box$/ }).click();

  // Jobs panel shows the captured output and a zero exit
  const detail = page.locator('#fleet-panel .fleet-detail');
  await expect(detail).toContainText('FLEET_E2E_MARKER', { timeout: 20000 });
  await expect(detail.locator('.fleet-result.ok .fr-badge')).toHaveText('exit 0');
});

test('a finished fleet job is findable from the Jobs button after a reload', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();
  await page.locator('.fleet-input').fill('echo SECOND_RUN_MARKER');
  await page.locator('#fleet-run').click();
  await page.getByRole('button', { name: /^Run on 1 box$/ }).click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('SECOND_RUN_MARKER', { timeout: 20000 });

  // Reload — the server kept the job; the Jobs button must list it
  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  const history = page.locator('#fleet-panel .fleet-history');
  await expect(history).toContainText('echo SECOND_RUN_MARKER', { timeout: 10000 });
  await history.locator('.fleet-history-item', { hasText: 'SECOND_RUN_MARKER' }).first().click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('SECOND_RUN_MARKER');
});
