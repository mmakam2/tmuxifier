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
  await expect(page.locator('.pane-header .pane-title').first()).toHaveText(/localhost/i);

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

  // Undock returns to a single full pane (the header button is always visible).
  await page.getByRole('button', { name: 'Undock db-primary' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
});

test('drag-to-dock: dropping a box row on the stage right edge docks it', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);

  // Native HTML5 drag: down on the row, at least two moves so the browser
  // promotes it to a drag operation, then drop over the right-edge zone.
  const row = page.locator('.box', { hasText: 'db-primary' });
  const rowBox = (await row.boundingBox())!;
  const stageBox = (await page.locator('#stage').boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBox.x + rowBox.width / 2 + 12, rowBox.y + rowBox.height / 2, { steps: 4 });
  await page.mouse.move(stageBox.x + stageBox.width - 30, stageBox.y + stageBox.height / 2, { steps: 10 });
  await expect(page.locator('.drop-zone-right')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await expect(page.locator('.pane-title', { hasText: 'db-primary' })).toBeVisible();
});

test('header bar: identity on a single pane, chip slot, and bar-refresh', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();

  // The bar exists on a lone full-stage pane (not just in split view).
  const header = page.locator('.pane-header');
  await expect(header).toHaveCount(1);
  await expect(header.locator('.pane-title')).toHaveText(/localhost/i);
  await expect(header.locator('.pane-target')).toHaveText('tmuxifierlocal');

  // Wait out the connect chip: once the WS is open the slot goes quiet
  // (no agent runs in the e2e sshd session).
  await expect(header.locator('.pane-chip')).toBeHidden({ timeout: 15000 });

  // Bar refresh rebuilds the terminal in place — pane count is unchanged and
  // the terminal reconnects (a live prompt appears again).
  await page.getByRole('button', { name: 'Reconnect localhost terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
});

test('plain-clicking a third box replaces the focused pane', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  // db-primary is focused (it was just docked); clicking untagged-worker replaces it.
  await page.locator('.box .name', { hasText: 'untagged-worker' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await expect(page.locator('.pane-title', { hasText: 'untagged-worker' })).toBeVisible();
  await expect(page.locator('.pane-title', { hasText: 'db-primary' })).toHaveCount(0);
});

test('sub-partition: stage-bottom drop under a 2-up gives a full-width third pane', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  const row = page.locator('.box', { hasText: 'untagged-worker' });
  const rowBox = (await row.boundingBox())!;
  const stageBox = (await page.locator('#stage').boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBox.x + rowBox.width / 2 + 12, rowBox.y + rowBox.height / 2, { steps: 4 });
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height - 20, { steps: 10 });
  await expect(page.locator('.drop-zone-bottom')).toBeVisible();
  await page.mouse.up();

  await expect(page.locator('.stage-pane')).toHaveCount(3);
  const c = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'untagged-worker' }) }).boundingBox())!;
  const a = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'localhost' }) }).boundingBox())!;
  expect(c.width).toBeGreaterThan(stageBox.width * 0.9); // full-width bottom pane
  expect(a.width).toBeLessThan(stageBox.width * 0.6);    // top pair still side-by-side
  expect(c.y).toBeGreaterThan(a.y + a.height - 8);       // and below them

  // Persistence of the tree across reload.
  await page.reload();
  await expect(page.locator('.stage-pane')).toHaveCount(3, { timeout: 10000 });

  // Undock the bottom pane: collapses back to the 2-up.
  await page.getByRole('button', { name: 'Undock untagged-worker' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
});

test('pane-edge drop splits only that pane', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  const b = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'db-primary' }) }).boundingBox())!;

  const row = page.locator('.box', { hasText: 'untagged-worker' });
  const rowBox = (await row.boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBox.x + rowBox.width / 2 + 12, rowBox.y + rowBox.height / 2, { steps: 4 });
  // bottom edge strip of pane B (inset from the stage rim so the stage zone doesn't win)
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.82, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator('.stage-pane')).toHaveCount(3);
  const bAfter = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'db-primary' }) }).boundingBox())!;
  const cAfter = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'untagged-worker' }) }).boundingBox())!;
  const aAfter = (await page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: 'localhost' }) }).boundingBox())!;
  expect(cAfter.width).toBeLessThan(bAfter.width + 8);              // C is inside B's column…
  expect(aAfter.height).toBeGreaterThan(cAfter.height + 8);         // …while A stays full height
});

test('stale-zone regression: a second drag builds zones from the current layout', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();

  // Drag-dock db-primary to the right edge (this used to leave stale zones).
  const row1 = page.locator('.box', { hasText: 'db-primary' });
  const r1 = (await row1.boundingBox())!;
  const stageBox = (await page.locator('#stage').boundingBox())!;
  await page.mouse.move(r1.x + r1.width / 2, r1.y + r1.height / 2);
  await page.mouse.down();
  await page.mouse.move(r1.x + r1.width / 2 + 12, r1.y + r1.height / 2, { steps: 4 });
  await page.mouse.move(stageBox.x + stageBox.width - 30, stageBox.y + stageBox.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  // Second drag: the zones must include a pane-edge zone for db-primary —
  // impossible with the stale set, which predates db-primary being docked.
  const row2 = page.locator('.box', { hasText: 'untagged-worker' });
  const r2 = (await row2.boundingBox())!;
  await page.mouse.move(r2.x + r2.width / 2, r2.y + r2.height / 2);
  await page.mouse.down();
  await page.mouse.move(r2.x + r2.width / 2 + 12, r2.y + r2.height / 2, { steps: 4 });
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2, { steps: 10 });
  await expect(page.locator(`[data-kind='pane-edge']`).first()).toBeVisible();
  const zoneCount = await page.locator('.drop-zone').count();
  expect(zoneCount).toBe(4 + 2 * 5); // 4 stage edges + 2 panes × (4 edges + replace)
  await page.mouse.up();
});
