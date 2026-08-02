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

  // Bar refresh kills the pane's tmux session and rebuilds the terminal, so it
  // arms on the first click and only fires on the second.
  const cap = page.locator('.pane-header .pane-refresh');
  await cap.click();
  await expect(cap).toHaveClass(/armed/);
  await expect(cap).toHaveText('⚠');
  await expect(cap).toHaveAccessibleName(/kills the tmux session/i);
  // Still one pane, and nothing has been torn down yet.
  await expect(page.locator('.stage-pane')).toHaveCount(1);

  // The second click commits: pane count is unchanged and the terminal
  // reconnects (a live prompt appears again).
  await cap.click();
  await expect(cap).not.toHaveClass(/armed/);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
});

test('an armed Reconnect disarms instead of firing when you click elsewhere', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.pane-header .pane-chip')).toBeHidden({ timeout: 15000 });

  const cap = page.locator('.pane-header .pane-refresh');
  await cap.click();
  await expect(cap).toHaveClass(/armed/);

  // A click anywhere else is the "anything else disarms" half of arm-then-fire.
  await page.locator('.pane-header .pane-title').click();
  await expect(cap).not.toHaveClass(/armed/);
  await expect(cap).toHaveText('↻');
  await expect(cap).toHaveAccessibleName('Reconnect localhost terminal');
});

test('Escape disarms an armed Reconnect', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.pane-header .pane-chip')).toBeHidden({ timeout: 15000 });

  const cap = page.locator('.pane-header .pane-refresh');
  await cap.click();
  await expect(cap).toHaveClass(/armed/);
  await page.keyboard.press('Escape');
  await expect(cap).not.toHaveClass(/armed/);
});

test('the sidebar Reconnect arms independently of the pane header cap', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.pane-header .pane-chip')).toBeHidden({ timeout: 15000 });

  const rowCap = page.locator('.box', { hasText: 'localhost' }).locator('.refresh').first();
  const headerCap = page.locator('.pane-header .pane-refresh');

  await rowCap.click();
  await expect(rowCap).toHaveClass(/armed/);
  // One armed control at a time: arming the header's cap moves the arm.
  await headerCap.click();
  await expect(headerCap).toHaveClass(/armed/);
  await expect(rowCap).not.toHaveClass(/armed/);
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
  // Exactly one landing preview paints while hovering — the zones themselves
  // are invisible hit targets, so the overlay stays calm.
  await expect(page.locator('.drop-preview')).toBeVisible();
  // Synthetic drags throttle dragover, so the preview can trail the cursor by
  // one update; nudge and poll until it reflects the final hover position.
  await page.mouse.move(stageBox.x + stageBox.width / 2 + 1, stageBox.y + stageBox.height - 20);
  await expect
    .poll(async () => (await page.locator('.drop-preview').boundingBox())!.width)
    .toBeGreaterThan(stageBox.width * 0.9); // full-width bottom band
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

// Regression: the last terminal row must be fully visible, never clipped.
//
// `.term` is `inset: 0` with a padded gutter under the global `* { box-sizing:
// border-box }`, so getComputedStyle('.term').height used to report the BORDER
// box — gutters included. FitAddon subtracts padding only from the `.xterm`
// element (which has none), never from its parent, so it handed out one row
// more than fits and the last row hung past `.pane-body`'s clip edge. The fix
// is `box-sizing: content-box` on `.term` — see the comment there.
//
// The overflow was `verticalPadding - (paneBodyHeight % 16)`, so it only bit for
// half of all pane heights — a single viewport size would pass or fail by luck.
// Sweeping 16 consecutive heights covers every residue of the 16px cell and
// makes the failure deterministic.
// Regression: the terminal must not strand a wide dead margin on its right.
//
// Three losses used to stack there: FitAddon reserves the viewport scrollbar's
// width whenever `scrollback !== 0` — and xterm's Viewport turns a measured 0
// (overlay scrollbars) into FALLBACK_SCROLL_BAR_WIDTH = 15 — plus an 8px side
// gutter on `.term`, plus the whole-cell quantisation remainder (up to one cell)
// pooling entirely on the right of a left-aligned xterm. ~23-31px of dead glass.
// The fix: `scrollback: 0` on the box terminal (tmux owns scrollback; the xterm
// buffer never scrolls behind tmux's alternate screen), a 4px gutter, and
// horizontal centring so the remainder splits across both edges.
//
// Width is swept so the cell remainder covers several residues — a single width
// could land remainder ≈ 0 and hide a padding/centring regression by luck.
test('the terminal leaves no wide dead margin on the right', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const height = page.viewportSize()!.height;
  const wide: Array<{ viewport: number; gapPx: number }> = [];
  for (let w = 1280; w < 1289; w++) {
    await page.setViewportSize({ width: w, height });
    await page.waitForTimeout(80); // let the resize listener re-fit and repaint
    const gapPx = await pane.evaluate((el) => {
      const body = el.querySelector('.pane-body')!;
      const screen = el.querySelector('.xterm-screen')!;
      return +(body.getBoundingClientRect().right - screen.getBoundingClientRect().right).toFixed(2);
    });
    if (gapPx > 16) wide.push({ viewport: w, gapPx });
  }
  expect(wide).toEqual([]);
});

test('the last terminal row is never clipped, at any pane height', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const width = page.viewportSize()!.width;
  const clipped: Array<{ viewport: number; overflowPx: number }> = [];
  for (let h = 700; h < 716; h++) {
    await page.setViewportSize({ width, height: h });
    await page.waitForTimeout(80); // let the resize listener re-fit and repaint
    const overflowPx = await pane.evaluate((el) => {
      const body = el.querySelector('.pane-body')!;
      const rows = el.querySelector('.xterm-rows')!;
      const last = rows.children[rows.children.length - 1];
      return +(last.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom).toFixed(2);
    });
    if (overflowPx > 0) clipped.push({ viewport: h, overflowPx });
  }
  expect(clipped).toEqual([]);
});
