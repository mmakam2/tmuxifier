import { test, expect } from '@playwright/test';

// The pane header's session/window picker, refreshed on demand, plus its
// per-row kill control.
//
// Its rows are rendered from the status snapshot, which is a server-side
// cache read on a client-side interval (30s each in production). A window
// opened on the box with `prefix-c` was therefore invisible here for up to a
// minute — and the current row went on naming a window that was no longer
// active — while the Edit Box modal, which probes live, showed it
// immediately. Reaching for the picker now re-probes that box first.
//
// This is the only level at which any of this can be tested: vitest runs
// without a DOM, so the pointer wiring in sessionPicker.ts has no unit-test
// seam.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('a window created on the box appears in the picker as it is reached for', async ({ page }) => {
  await login(page);

  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const picker = pane.locator('.session-picker');
  const trigger = picker.locator('.session-picker-trigger');
  await expect(trigger).toBeVisible();

  // Create a second window the way an operator does — from inside the session,
  // with nothing telling Tmuxifier it happened.
  await pane.click();
  await page.keyboard.type('tmux new-window -n e2ewin');
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  // Reaching for the control is the trigger. The request assertion is the
  // non-vacuous half: without the on-demand probe there is no such request at
  // all, and the row below would arrive only on the next 30s client poll.
  const probed = page.waitForRequest(
    (r) => /\/api\/boxes\/[^/]+\/probe$/.test(r.url()) && r.method() === 'POST',
    { timeout: 10000 },
  );
  await trigger.hover();
  await probed;
  await trigger.click();

  await expect(picker.locator('.session-picker-pick', { hasText: 'e2ewin' })).toHaveCount(1, { timeout: 5000 });
  // The header still answers "which window am I looking at": tmux makes a new
  // window active, so the current row must have followed it there.
  await expect(picker.locator('.session-picker-row.current .session-picker-pick')).toContainText('e2ewin');

  // Leave the fixture's shared session as it was found — the suite runs
  // workers: 1 against one tmux session, so a stray window would follow every
  // later spec around. The popup opened above moved focus onto its first row;
  // clicking the pane closes it (focus leaving the picker) and refocuses the
  // terminal, so the keystrokes below land in the shell rather than on a
  // button.
  await pane.click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
});

test('one click on × does not kill — arm-then-fire holds', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  // A throwaway session, so the fixture's shared one survives for later specs
  // (the suite runs workers: 1 against a single tmux server).
  await pane.click();
  await page.keyboard.type('tmux new-session -d -s e2ekill');
  await page.keyboard.press('Enter');

  const picker = pane.locator('.session-picker');
  await picker.locator('.session-picker-trigger').click();
  const row = picker.locator('.session-picker-row', { hasText: 'e2ekill' });
  await expect(row).toHaveCount(1, { timeout: 10000 });

  // First click ARMS. The row must still be there, and the cap must now state
  // its consequence rather than showing a bare ×.
  await row.locator('.session-picker-kill').click();
  await expect(row.locator('.session-picker-kill.armed')).toHaveText(/kill/i);
  await expect(row).toHaveCount(1);

  // Second click commits.
  await row.locator('.session-picker-kill').click();
  await expect(picker.locator('.session-picker-row', { hasText: 'e2ekill' })).toHaveCount(0, { timeout: 15000 });
});

test('killing a window removes it and leaves the session', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  await pane.click();
  await page.keyboard.type('tmux new-window -n e2ekillwin');
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const picker = pane.locator('.session-picker');
  await picker.locator('.session-picker-trigger').click();
  const row = picker.locator('.session-picker-row', { hasText: 'e2ekillwin' });
  await expect(row).toHaveCount(1, { timeout: 10000 });
  await row.locator('.session-picker-kill').click();
  await row.locator('.session-picker-kill').click();

  await expect(picker.locator('.session-picker-row', { hasText: 'e2ekillwin' })).toHaveCount(0, { timeout: 15000 });
  // The session itself survived — only the window went.
  await expect(picker.locator('.session-picker-row')).not.toHaveCount(0);
});
