import { test, expect, type Page } from '@playwright/test';

// The phone composer at the narrowest real width in the fleet (Z Fold 6 cover
// screen). Sends are asserted by pty EFFECT — output text a command produced,
// never the echoed command line, which looks identical whether or not Enter
// was ever sent. Geometry is asserted by rects: toBeVisible() cannot see an
// element scrolled out of an overflow container (the touchBar.spec.ts lesson).
//
// Voice leg: Chromium's fake media device + the fixture transcript, exactly
// as voice.spec.ts.
test.use({
  viewport: { width: 344, height: 844 },
  hasTouch: true,
  isMobile: true,
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function openOnPhone(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await page.click('#phone-menu');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
  // The shared tmux session may hold a previous client's unsubmitted line.
  await page.keyboard.press('Control+U');
}

async function openComposer(page: Page) {
  await page.click('.touch-keys > button[aria-label="compose"]'); // the pinned ✏️ toggles open/close
  await expect(page.locator('.composer-field')).toBeVisible();
}

test('send collapses a multi-line draft to one line and submits it', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  await page.locator('.composer-field').fill('echo composer-$((20+4))\nlines');
  await page.click('button[aria-label="send"]');
  // Output proves BOTH properties: `composer-24` only exists if the shell RAN
  // the line (the echoed command shows the literal $((20+4))), and `24 lines`
  // on one output line only exists if the newline collapsed to a space.
  await expect(page.locator('.xterm-rows').first()).toContainText('composer-24 lines', { timeout: 10000 });
});

test('send on an empty field is a bare Enter', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  try {
    await page.locator('.composer-field').fill('read x; echo "got<$x>"');
    await page.click('button[aria-label="send"]');   // shell now waits on read
    await page.click('button[aria-label="send"]');   // empty field -> bare Enter completes it
    await expect(page.locator('.xterm-rows').first()).toContainText('got<>', { timeout: 10000 });
  } finally {
    // Never leave the shared session wedged inside `read` for later tests
    // (the round-2 cat -v lesson): refocus the pane and interrupt.
    await page.click('.touch-keys > button[aria-label="compose"]').catch(() => {});
    await page.keyboard.press('Control+C').catch(() => {});
  }
});

test('the draft survives closing and reopening the composer', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  await page.locator('.composer-field').fill('keep me');
  // NOTE: the closer hides itself on pointerdown. If click() ever flakes on
  // that mid-gesture hide, switch to dispatchEvent('pointerdown') — the
  // voice.spec.ts precedent for handlers that don't live on click.
  await page.click('.touch-keys > button[aria-label="compose"]'); // toggle closed
  await expect(page.locator('.composer-field')).toBeHidden();
  await openComposer(page);
  await expect(page.locator('.composer-field')).toHaveValue('keep me');
});

test('composing fits 344px: field, send, compose and mic on screen; caps and enter gone', async ({ page }) => {
  await openOnPhone(page);
  await expect(page.locator('.voice-btn')).toBeVisible({ timeout: 10000 }); // mic mounted before measuring
  // IDLE first: ✏️ took the ctrl cap's slot, so the closed bar must still fit
  // 344px with nothing to scroll — the round-2 invariant this cap once broke.
  const idle = (await page.locator('.touch-keys > button[aria-label="compose"]').boundingBox())!;
  expect(idle).not.toBeNull();
  expect(idle.x).toBeGreaterThanOrEqual(0);
  expect(idle.x + idle.width).toBeLessThanOrEqual(344);
  const idleBar = await page.locator('.touch-keys').evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(idleBar.scrollWidth).toBeLessThanOrEqual(idleBar.clientWidth);
  await openComposer(page);
  for (const sel of ['.composer-field', 'button[aria-label="send"]', '.touch-keys > button[aria-label="compose"]', '.voice-btn']) {
    const box = (await page.locator(sel).boundingBox())!;
    expect(box, sel).not.toBeNull();
    expect(box.x, sel).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, sel).toBeLessThanOrEqual(344);
  }
  const bar = await page.locator('.touch-keys').evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
  await expect(page.locator('.touch-caps')).toBeHidden();
  await expect(page.locator('.touch-keys > button[aria-label="enter"]')).toBeHidden();
});

test('focus follows the toggle: open focuses the field, close returns to xterm', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('composer-field');
  await page.click('.touch-keys > button[aria-label="compose"]');
  expect(await page.evaluate(() => document.activeElement?.className || '')).toContain('xterm-helper-textarea');
});

test('dictation lands in the draft, not the pane, while composing', async ({ page }) => {
  await openOnPhone(page);
  await openComposer(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });
  await mic.dispatchEvent('pointerdown');
  await page.waitForTimeout(500);
  await mic.dispatchEvent('pointerup');
  await expect(page.locator('.composer-field')).toHaveValue(/hello from the fixture/, { timeout: 15000 });
  // And the pane must NOT have received it — that is the sink's whole contract.
  await expect(page.locator('.xterm-rows').first()).not.toContainText('hello from the fixture');
});
