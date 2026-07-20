import { test, expect, type Page } from '@playwright/test';

// Chromium grants microphone access without a prompt under this permission,
// and --use-fake-device-for-media-stream feeds it a synthetic tone. The
// transcript itself comes from the fixture server, so these assertions are
// about plumbing, not speech recognition accuracy.
//
// Note the suite's baseURL is http://127.0.0.1:7438 — plain HTTP, but a
// loopback address IS a secure context per the W3C definition, so
// getUserMedia and window.isSecureContext both work here without TLS.
test.use({
  permissions: ['microphone'],
  // NOTE: the real Chromium flag is --use-fake-device-for-media-stream, not
  // "-for-media-capture" (which does not exist and is silently ignored by
  // Chrome). With the wrong name, enumerateDevices() returns an empty list
  // and getUserMedia() rejects with NotFoundError ("Requested device not
  // found") — confirmed empirically against this repo's bundled Chromium
  // before landing on the corrected flag below.
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

// Same login and open-box flow as tmuxifier.spec.ts.
async function openLocalhostBox(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  // Wait for the remote shell to actually draw: the pane must be at a prompt
  // for classifyPaneState to permit injection at all.
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
}

test('dictation types the transcript into the tmux pane', async ({ page }) => {
  await openLocalhostBox(page);

  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });
  await expect(mic).toBeEnabled();

  await mic.dispatchEvent('mousedown');
  await page.waitForTimeout(500);          // capture a little synthetic audio
  await mic.dispatchEvent('mouseup');

  // The fixture always returns this text (padded with a leading space and
  // trailing newline, like the real whisper-server); seeing the normalized
  // form in the pane proves the whole chain: capture, WAV encode, POST,
  // engine, normalize, send-keys.
  await expect(page.locator('.xterm-rows').first())
    .toContainText('hello from the fixture', { timeout: 15000 });
});

test('the transcript is typed but never submitted', async ({ page }) => {
  await openLocalhostBox(page);
  const mic = page.locator('.voice-btn');
  await expect(mic).toBeVisible({ timeout: 10000 });

  await mic.dispatchEvent('mousedown');
  await page.waitForTimeout(300);
  await mic.dispatchEvent('mouseup');
  await expect(page.locator('.xterm-rows').first())
    .toContainText('hello from the fixture', { timeout: 15000 });

  // Never auto-Enter: the shell must not have run it. If Enter had been sent,
  // the shell would report a command-not-found for 'hello'.
  await page.waitForTimeout(1000);
  await expect(page.locator('.xterm-rows').first()).not.toContainText('command not found');
});
