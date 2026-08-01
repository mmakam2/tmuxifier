import { test, expect } from '@playwright/test';

// Nothing covered a dropped-and-restored WebSocket before this: the existing
// reattach specs reload the page, which builds a fresh Terminal, and the whole
// hazard here is the reconnect path that REUSES the live one.
//
// This does not discriminate the replay-clear in sessions.js — the fixture's
// tmux session is a near-empty prompt, so the replay's own absolute-positioned
// output lands in the same cells and the screen comes out clean either way.
// What it does guard is that a reconnect leaves a clean, working terminal at
// all, which is worth its runtime: an earlier attempt at the same bug — having
// the client ask the server to skip the replay entirely — passed every unit and
// route test and still broke this, because the client's own "[disconnected…]"
// chrome desynced its grid from tmux's and nothing repainted it.
test('a dropped socket reconnects to a clean, working terminal', async ({ page }) => {
  // Capture the live socket objects so the test can drop one. Chromium's
  // setOffline only gates NEW requests — it leaves an established WebSocket
  // open — so emulated offline cannot produce the blip this test needs.
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    (window as unknown as { __termSockets: WebSocket[] }).__termSockets = [];
    window.WebSocket = new Proxy(Original, {
      construct(target, args: [string, (string | string[])?]) {
        const ws = new target(...args);
        if (String(args[0]).includes('/term')) {
          (window as unknown as { __termSockets: WebSocket[] }).__termSockets.push(ws);
        }
        return ws;
      },
    });
  });

  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');

  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  const screen = page.locator('.xterm-rows').first();
  await expect(screen).toContainText(/[#$%>]/, { timeout: 15000 });

  await page.keyboard.type('echo RECONNECT_BEFORE\n');
  await expect(screen).toContainText('RECONNECT_BEFORE', { timeout: 15000 });
  const countBefore = ((await screen.textContent()) ?? '').split('RECONNECT_BEFORE').length - 1;

  // Drop the socket the way a network blip does; the client's own backoff
  // reconnects it into the still-live PTY.
  await page.evaluate(() => {
    const socks = (window as unknown as { __termSockets: WebSocket[] }).__termSockets;
    socks[socks.length - 1].close();
  });
  await page.waitForFunction(() => {
    const socks = (window as unknown as { __termSockets: WebSocket[] }).__termSockets;
    return socks.length > 1 && socks[socks.length - 1].readyState === WebSocket.OPEN;
  }, null, { timeout: 20000 });

  // The rebuilt screen carries neither the client's own reconnect chrome nor a
  // second copy of what was already on it.
  await expect(screen).not.toContainText('disconnected', { timeout: 15000 });
  await expect(screen).not.toContainText('connecting to');
  const countAfter = ((await screen.textContent()) ?? '').split('RECONNECT_BEFORE').length - 1;
  expect(countAfter).toBe(countBefore);

  // And it is still a working terminal.
  await page.keyboard.type('echo RECONNECT_AFTER\n');
  await expect(screen).toContainText('RECONNECT_AFTER', { timeout: 15000 });
});
