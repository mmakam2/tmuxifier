import { test, expect } from '@playwright/test';

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

// The one path no unit test can prove: a check defined in the browser, run by
// the server, folded into an alert, and silenced again — through the real HTTP
// routes, the real sealed store, and the real append-only event log.
test('a check created in the hub fails, folds into an alert, and can be muted', async ({ page }) => {
  await login(page);

  await page.click('#alerts');
  const hub = page.locator('.alerts-hub');
  await expect(hub).toBeVisible();

  await hub.locator('.pve-tab', { hasText: 'Checks' }).click();
  await expect(hub.getByText(/No checks yet/)).toBeVisible();
  await hub.getByRole('button', { name: /New check/ }).click();

  // Port 1 is refused immediately, so the check fails on its first run without
  // waiting out a timeout.
  const form = page.locator('.modal').filter({ hasText: 'New check' });
  await form.getByLabel('Label').fill('Unreachable surface');
  await form.getByLabel('URL').fill('http://127.0.0.1:1/health');
  await form.locator('input[name="check-sev"][value="critical"]').check();
  await form.getByRole('button', { name: 'Create', exact: true }).click();

  const row = hub.locator('.pve-row').filter({ hasText: 'Unreachable surface' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('not run yet');

  await row.getByRole('button', { name: /Run now/ }).click();
  await expect(row).toContainText('failing');

  // The occurrence is in the feed whether or not any rule would notify on it —
  // this is the "confirm a new check works without paging anyone" path.
  await hub.locator('.pve-tab', { hasText: 'Feed' }).click();
  await expect(hub.locator('.alert-row').filter({ hasText: 'Unreachable surface' }).first()).toBeVisible();

  await hub.locator('.pve-tab', { hasText: 'Alerts' }).click();
  const alertRow = hub.locator('.alert-row').filter({ hasText: 'Unreachable surface' }).first();
  await expect(alertRow).toBeVisible();
  await expect(alertRow).toHaveClass(/critical/);

  // Exact name: 'Mute' is a substring of 'Unmute', so a loose match would find
  // the post-click state and pass without proving anything.
  await alertRow.getByRole('button', { name: 'Mute', exact: true }).click();
  await expect(
    hub.locator('.alert-row').filter({ hasText: 'Unreachable surface' }).first()
      .getByRole('button', { name: 'Unmute', exact: true }),
  ).toBeVisible();
});

// A heartbeat is satisfied by something calling in, so the hub has to show what
// to call. Without this the check type ships undeliverable: the operator would
// have a token with nowhere to send it.
test('a heartbeat check shows the check-in URL and starts out failing', async ({ page }) => {
  await login(page);
  await page.click('#alerts');
  const hub = page.locator('.alerts-hub');
  await hub.locator('.pve-tab', { hasText: 'Checks' }).click();
  await hub.getByRole('button', { name: /New check/ }).click();

  const form = page.locator('.modal').filter({ hasText: 'New check' });
  await form.getByLabel('Label').fill('Nightly backup');
  await form.locator('input[name="check-type"][value="heartbeat"]').check();
  await form.getByLabel(/Expect a check-in every/).fill('86400');
  await form.getByRole('button', { name: 'Create', exact: true }).click();

  const row = hub.locator('.pve-row').filter({ hasText: 'Nightly backup' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('/hb/');

  // Never having checked in is a failure, not a pass — the whole point of the
  // type is that silence is the signal.
  await row.getByRole('button', { name: /Run now/ }).click();
  await expect(row).toContainText('never checked in');
});
