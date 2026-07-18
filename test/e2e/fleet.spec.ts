import { test, expect } from '@playwright/test';

async function loginAndWait(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('fleet command runs on a selected box and shows captured output', async ({ page }) => {
  await loginAndWait(page);

  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();

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

test('the master "Select all" checkbox selects and clears every shown box', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();

  // Three boxes are seeded (localhost + db-primary under Prod, untagged-worker).
  await expect(page.locator('.fleet-select-all')).toContainText('Select all (3)');
  const selectAll = page.locator('.fleet-select-all .select-all-check');

  await selectAll.check();
  await expect(page.locator('input.box-check:checked')).toHaveCount(3);
  await expect(page.locator('#fleet-run')).toHaveText('Run on 3');

  await selectAll.uncheck();
  await expect(page.locator('input.box-check:checked')).toHaveCount(0);
  await expect(page.locator('#fleet-run')).toBeDisabled();

  // Partial selection (one tag group) must NOT mark the master — it's binary,
  // "on" only when every shown box is selected (no indeterminate highlight).
  await page.locator('.box-group[data-tag-key="prod"] .group-check').check();
  await expect(page.locator('input.box-check:checked')).toHaveCount(2);
  await expect(selectAll).not.toBeChecked();
  expect(await selectAll.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(false);
});

test('a finished fleet job is findable from the Jobs button after a reload', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();
  await page.locator('.fleet-input').fill('echo SECOND_RUN_MARKER');
  await page.locator('#fleet-run').click();
  await page.getByRole('button', { name: /^Run on 1 box$/ }).click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('SECOND_RUN_MARKER', { timeout: 20000 });

  // Reload — the server kept the job; the Jobs button must list it
  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Fleet Jobs', exact: true }).click();
  const history = page.locator('#fleet-panel .fleet-history');
  await expect(history).toContainText('echo SECOND_RUN_MARKER', { timeout: 10000 });
  await history.locator('.fleet-history-item', { hasText: 'SECOND_RUN_MARKER' }).first().click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('SECOND_RUN_MARKER');
});

test('Ctrl+Enter inside the script editor triggers Run instead of inserting a newline', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();

  // Open the CodeMirror script editor. It takes focus on open, and the
  // document-level fallback defers to the editor's own keymap while it is
  // focused — so this exercises the editor keymap itself, where defaultKeymap's
  // Mod-Enter (insertBlankLine) used to shadow the run binding.
  await page.locator('.fleet-expand').click();
  await expect(page.locator('.fleet-script-modal .cm-content')).toBeVisible();
  await page.keyboard.type('echo CM_RUN_MARKER');
  await page.keyboard.press('Control+Enter');

  // A successful run closes the modal and lands on the live job detail.
  const detail = page.locator('#fleet-panel .fleet-detail');
  await expect(detail).toContainText('CM_RUN_MARKER', { timeout: 20000 });
});
