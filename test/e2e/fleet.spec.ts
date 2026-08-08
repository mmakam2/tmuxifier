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
  const row = history.locator('.fleet-job-row', { hasText: 'SECOND_RUN_MARKER' }).first();
  await row.click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('SECOND_RUN_MARKER');
  // Clicking a row must visibly select it — the drawer used to repaint only the
  // detail, which at any real history depth was off screen, so a click looked
  // like it had done nothing at all.
  await expect(row).toHaveAttribute('aria-selected', 'true');
  // A settled job belongs to the archive, and the archive alone.
  await expect(page.locator('#fleet-panel .fleet-active')).toBeHidden();
});

test('a running job is listed apart from history, and Escape closes the drawer', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();
  // Long enough to still be running when the drawer paints.
  await page.locator('.fleet-input').fill('sleep 6; echo ACTIVE_RUN_MARKER');
  await page.locator('#fleet-run').click();
  await page.getByRole('button', { name: /^Run on 1 box$/ }).click();

  // In flight: the ACTIVE section carries it, the archive does not, and the
  // sidebar key shows the running count even before the job settles.
  const active = page.locator('#fleet-panel .fleet-active');
  await expect(active).toBeVisible();
  await expect(active.locator('.fleet-job-row')).toContainText('ACTIVE_RUN_MARKER');
  await expect(active.locator('.fj-lamp.amber')).toBeVisible();
  await expect(page.locator('#fleet-panel .fleet-history')).not.toContainText('ACTIVE_RUN_MARKER');
  await expect(page.locator('#fleet-jobs .events-badge')).toHaveText('1');

  // It moves to the archive on its own once it lands — the list polls itself
  // now, so this needs no click and no reload.
  await expect(page.locator('#fleet-panel .fleet-history')).toContainText('ACTIVE_RUN_MARKER', { timeout: 20000 });
  await expect(active).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(page.locator('#fleet-panel')).not.toHaveClass(/open/);
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

test('a saved script survives a reload and loads back into the editor', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();

  await page.locator('.fleet-expand').click();
  await expect(page.locator('.fleet-script-modal .cm-content')).toBeVisible();
  await page.keyboard.type('echo SAVED_SCRIPT_MARKER');
  await page.locator('.fleet-script-modal .fs-name').fill('marker script');
  await page.locator('.fleet-script-modal .fs-save').click();

  // The row is really painted, not merely present in the DOM.
  const row = page.locator('.fleet-script-rail .fs-row', { hasText: 'marker script' });
  await expect(row).toBeVisible();

  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.fleet-expand').click();
  await page.locator('.fleet-script-rail .fs-row', { hasText: 'marker script' }).locator('.fs-open').click();
  await expect(page.locator('.fleet-script-modal .cm-content')).toContainText('echo SAVED_SCRIPT_MARKER');
});

// A big selection used to grow the script modal past the viewport in both
// directions — the title off the top, the Cancel/Save/Run row off the bottom —
// because nothing bounded the modal's height and the target list wrapped to a
// dozen lines. The fleet fixture only seeds three boxes, so the list response is
// padded here rather than in the shared server, which other specs count on.
test('the script editor keeps its footer keys on screen with a large selection', async ({ page }) => {
  await page.route('**/api/boxes', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const boxes = await res.json();
    const filler = Array.from({ length: 57 }, (_, i) => ({
      ...boxes[0],
      id: `filler-${i}`,
      label: `fleet-filler-${String(i).padStart(2, '0')}`,
      tags: [],
    }));
    await route.fulfill({ response: res, json: [...boxes, ...filler] });
  });

  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.fleet-select-all .select-all-check').check();
  await expect(page.locator('#fleet-run')).toHaveText('Run on 60');

  await page.locator('.fleet-expand').click();
  const modal = page.locator('.fleet-script-modal');
  await expect(modal.locator('.cm-content')).toBeVisible();

  const viewport = page.viewportSize()!;

  // The modal fits the viewport, so nothing is clipped off the top either.
  const modalBox = (await modal.boundingBox())!;
  expect(modalBox.y).toBeGreaterThanOrEqual(0);
  expect(modalBox.y + modalBox.height).toBeLessThanOrEqual(viewport.height);

  // The commit key — the whole point — is reachable, not merely present.
  const run = modal.locator('.fleet-script-run');
  await expect(run).toBeInViewport({ ratio: 1 });
  await expect(run).toHaveText('Run on 60 boxes');

  // The names are bounded and scrollable rather than clipped: the band carries
  // more content than it shows, and the count says how much.
  const targets = modal.locator('.fleet-confirm-targets');
  const overflow = await targets.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeGreaterThan(0);
  await expect(modal.locator('.fleet-targets .fs-eyebrow')).toHaveText('Targets · 60 boxes');

  // The editor is the part that gave way, and it is still usable.
  const editor = (await modal.locator('.fleet-script .cm-editor').boundingBox())!;
  expect(editor.height).toBeGreaterThanOrEqual(200);
});

test('running a saved script labels the job with the script name', async ({ page }) => {
  await loginAndWait(page);
  await page.getByRole('button', { name: 'Fleet Command', exact: true }).click();
  await page.locator('.box', { hasText: 'localhost' }).locator('input.box-check').check();

  await page.locator('.fleet-expand').click();
  await page.keyboard.type('echo NAMED_RUN_MARKER');
  await page.locator('.fleet-script-modal .fs-name').fill('named run');
  await page.locator('.fleet-script-modal .fs-save').click();
  await expect(page.locator('.fleet-script-rail .fs-row.selected', { hasText: 'named run' })).toBeVisible();

  await page.locator('.fleet-script-modal .fleet-script-run').click();
  await expect(page.locator('#fleet-panel .fleet-detail')).toContainText('NAMED_RUN_MARKER', { timeout: 20000 });
  // The history row shows the script's name rather than the raw command.
  await expect(page.locator('#fleet-panel .fleet-history')).toContainText('named run');
});
