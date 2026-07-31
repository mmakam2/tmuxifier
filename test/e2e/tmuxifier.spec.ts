import { test, expect } from '@playwright/test';

test('login, open a box terminal, reload, and reattach to the same session', async ({ page }) => {
  // Login
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const localhost = page.locator('.box .name', { hasText: 'localhost' });

  // Wait for dashboard with seeded box
  await expect(localhost).toBeVisible({ timeout: 10000 });

  // Open the box terminal and wait for the tmux status bar: input typed while
  // the WebSocket is still connecting is dropped, so typing must wait until the
  // remote session has actually drawn.
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });

  // Type a unique marker into the shell
  await page.keyboard.type('echo TMUXIFIER_E2E_MARKER\n');
  await expect(page.locator('.xterm-rows').first()).toContainText('TMUXIFIER_E2E_MARKER', { timeout: 10000 });

  // Reload — auth cookie persists so dashboard comes back; tmux session must survive
  await page.reload();
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();

  // Marker must still be visible proving reattach to the same tmux session
  await expect(page.locator('.xterm-rows').first()).toContainText('TMUXIFIER_E2E_MARKER', { timeout: 10000 });
});

test('logout then re-login can reopen a box terminal (no stale detached tab)', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });

  // Logout must dispose the terminal tab; before the fix the module-level tabs
  // map kept a detached element, so re-opening the box after re-login showed
  // nothing (the stage stayed on the empty state until a full page reload).
  await page.click('#logout');
  await expect(page.locator('#pw')).toBeVisible({ timeout: 10000 });

  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();

  // Wait for the reattached tmux to draw before typing (see the comment above).
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
  await page.keyboard.type('echo TMUXIFIER_RELOGIN_MARKER\n');
  await expect(page.locator('.xterm-rows').first()).toContainText('TMUXIFIER_RELOGIN_MARKER', { timeout: 10000 });
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

test('sidebar groups boxes by tag and remembers collapsed groups during search', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const prodGroup = page.locator('.box-group[data-tag-key="prod"]');
  const untaggedGroup = page.locator('.box-group[data-tag-key="__untagged__"]');

  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Untagged\s+1/ })).toBeVisible();
  await expect(prodGroup.locator('.box .name')).toHaveText(['db-primary', 'localhost']);
  await expect(untaggedGroup.locator('.box .name')).toHaveText(['untagged-worker']);

  await page.getByRole('button', { name: /Prod\s+2/ }).click();
  await expect(prodGroup.locator('.group-body')).toBeHidden();

  await page.reload();
  await expect(page.locator('.layout')).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible();
  await expect(prodGroup.locator('.group-body')).toBeHidden();

  await expect(page.locator('#search-clear')).toBeHidden();
  await page.fill('#search', 'prod');
  await expect(prodGroup.locator('.group-body')).toBeVisible();
  await expect(prodGroup.locator('.box .name')).toHaveText(['db-primary', 'localhost']);

  // The clear key empties the field and restores the unfiltered sidebar.
  await expect(page.locator('#search-clear')).toBeVisible();
  await page.click('#search-clear');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(page.locator('#search-clear')).toBeHidden();
  await expect(prodGroup.locator('.group-body')).toBeHidden();
});

test('host shell clears active tag group after opening a grouped box', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const prodGroup = page.locator('.box-group[data-tag-key="prod"]');
  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible({ timeout: 10000 });

  await prodGroup.locator('.box .name').first().click();
  await expect(prodGroup).toHaveClass(/active-child/);

  await page.locator('.local-name').click();
  await expect(prodGroup).not.toHaveClass(/active-child/);
  await expect(page.locator('.local-shell')).toHaveClass(/active/);
});

test('edit box tag joins an existing group and can be cleared', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: /Untagged\s+1/ })).toBeVisible();

  await page.locator('.box', { hasText: 'untagged-worker' }).locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  await page.getByLabel('Tag', { exact: true }).fill('prod');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('button', { name: /Prod\s+3/ })).toBeVisible();
  await expect(page.locator('.box-group[data-tag-key="prod"] .box .name')).toHaveText([
    'db-primary',
    'localhost',
    'untagged-worker',
  ]);

  await page.locator('.box', { hasText: 'untagged-worker' }).locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  await page.getByLabel('Tag', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('button', { name: /Prod\s+2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Untagged\s+1/ })).toBeVisible();
  await expect(page.locator('.box-group[data-tag-key="__untagged__"] .box .name')).toHaveText(['untagged-worker']);
});

test('standby dashboard renders when no terminal is docked and opens a box', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  // With a seeded box the dashboard shows the fleet strip under the masthead
  // prompt; the fresh-install hero stays hidden.
  const dash = page.locator('.dash');
  await expect(dash).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.dash-head .empty-prompt')).toBeVisible();
  const cell = page.locator('.dash-box', { hasText: 'localhost' });
  await expect(cell).toBeVisible({ timeout: 10000 });

  // Clicking a fleet cell docks that box's terminal — the dashboard yields.
  await cell.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
  await expect(dash).toBeHidden();

  // The nameplate is the home key: back to the dashboard, terminal undocked
  // but still running (re-docking reattaches).
  await page.click('#home');
  await expect(dash).toBeVisible({ timeout: 10000 });
});
