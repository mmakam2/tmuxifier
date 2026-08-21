import { test, expect } from '@playwright/test';

// The pane header's session/window dropdown, refreshed on demand.
//
// Its options are rendered from the status snapshot, which is a server-side
// cache read on a client-side interval (30s each in production). A window
// opened on the box with `prefix-c` was therefore invisible here for up to a
// minute — and the ✓ went on sitting on a window that was no longer the active
// one — while the Edit Box modal, which probes live, showed it immediately.
// Reaching for the dropdown now re-probes that box first.
//
// This is the only level at which the fix can be tested: vitest runs without a
// DOM, so the pointer wiring in paneHeader.ts has no unit-test seam.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('a window created on the box appears in the dropdown as it is reached for', async ({ page }) => {
  await login(page);

  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const sel = pane.locator('.pane-session');
  await expect(sel).toBeVisible();

  // Create a second window the way an operator does — from inside the session,
  // with nothing telling Tmuxifier it happened.
  await pane.click();
  await page.keyboard.type('tmux new-window -n e2ewin');
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  // Reaching for the control is the trigger. The request assertion is the
  // non-vacuous half: without the on-demand probe there is no such request at
  // all, and the option below would arrive only on the next 30s client poll.
  const probed = page.waitForRequest(
    (r) => /\/api\/boxes\/[^/]+\/probe$/.test(r.url()) && r.method() === 'POST',
    { timeout: 10000 },
  );
  await sel.hover();
  await probed;

  await expect(sel.locator('option', { hasText: 'e2ewin' })).toHaveCount(1, { timeout: 5000 });
  // And the header now answers "which window am I looking at" correctly: tmux
  // makes a new window active, so the selection must have followed it there.
  await expect(sel).toHaveValue(/^w:/);
  const selected = await sel.evaluate((el: HTMLSelectElement) => el.selectedOptions[0]?.textContent ?? '');
  expect(selected).toContain('e2ewin');

  // Leave the fixture's shared session as it was found — the suite runs
  // workers: 1 against one tmux session, so a stray window would follow every
  // later spec around.
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
});
