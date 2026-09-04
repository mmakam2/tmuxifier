import { test, expect, type Page } from '@playwright/test';

// Same fake-microphone setup as voice.spec.ts: loopback HTTP is a secure
// context, and the flags feed getUserMedia a synthetic tone.
test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

async function openLocalhostBox(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
}

// A stand-in for Claude Code: a foreground process whose argv[0] is `claude`,
// which is what tmux's #{pane_current_command} reports (it reads the
// foreground process group leader's cmdline). A subshell keeps the pane's
// shell alive for the specs that run after this one; Ctrl+C ends it.
async function runFakeClaude(page: Page) {
  // Clear whatever unsubmitted line a previous spec left sitting at the
  // prompt — voice.spec.ts's own dictation tests deliberately never press
  // Enter (see its "never submitted" test), and this pane/session is shared
  // across every spec file in the run (one fixture box, one tmux session,
  // workers: 1). Without this, typing the stand-in command appends it to
  // whatever text is already there and the shell never runs it.
  await page.keyboard.press('Control+U');
  await page.keyboard.type('( exec -a claude sleep 300 )');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
}

test('pressing the mic on a Claude pane links and paints live; pressing again unlinks', async ({ page }) => {
  await openLocalhostBox(page);
  await runFakeClaude(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });
  await expect(mic).toBeEnabled();
  await mic.dispatchEvent('pointerdown');
  await mic.dispatchEvent('pointerup');
  // probe (pane-kind over the fixture sshd) + writer readiness (300 ms)
  await expect(mic).toHaveAttribute('data-state', 'live', { timeout: 15000 });
  await expect(mic).toHaveText(/live/);
  await mic.dispatchEvent('pointerdown');
  await mic.dispatchEvent('pointerup');
  await expect(mic).toHaveAttribute('data-state', 'idle', { timeout: 5000 });
  // No transcript line ever reaches the pane on the link path.
  await expect(page.locator('.xterm-rows').first()).not.toContainText('hello from the fixture');
  await page.keyboard.press('Control+c');
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 10000 });
});

test('the same press at a shell prompt still dictates', async ({ page }) => {
  await openLocalhostBox(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeEnabled({ timeout: 10000 });
  await mic.dispatchEvent('pointerdown');
  await page.waitForTimeout(500);
  await mic.dispatchEvent('pointerup');
  await expect(page.locator('.xterm-rows').first()).toContainText('hello from the fixture', { timeout: 15000 });
  await expect(mic).toHaveAttribute('data-state', 'idle');
});
