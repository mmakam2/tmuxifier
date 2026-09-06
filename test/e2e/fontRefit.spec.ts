import { test, expect, type Route } from '@playwright/test';

// The hard-refresh case. On a cold cache the terminal's webfonts are still in
// flight when the pane opens, so xterm measures its cell with the FALLBACK
// font, fits the pane to that (a smaller cell — more rows), and the WebSocket
// announces that size to the PTY. When the fonts land, refitWhenFontReady
// re-measures and re-fits xterm to the real cell — fewer rows — and tmux has
// to hear about THAT size too, or it keeps drawing for the taller screen and
// the bottom rows (the status bar, a prompt's last lines) never appear on the
// glass. A normal refresh serves the fonts from cache, so the refit lands
// before the socket ever opens and the one size it sends is already right —
// which is why the bug only ever showed after a hard refresh.
//
// Holding the .woff2 responses until after the socket has spoken reproduces
// that ordering deterministically; measured here, the fallback cell is 14px
// tall against Meslo's 16px at 12px, so the two fits differ by several rows.
test('the size tmux ends up with is the one xterm settled on after the webfonts loaded', async ({ page }) => {
  let released = false;
  const held: Route[] = [];
  // Only the TERMINAL faces are held — the chrome's Geist must flow, since a
  // held page-load subresource keeps the load event page.goto waits on from
  // ever firing. Once released, later font requests (a face fetched only after
  // the first three settle) go straight through, or fonts.ready never resolves.
  await page.route(/\/(Meslo|JuliaMono)[^/]*\.woff2$/, (route) => { if (released) void route.continue(); else held.push(route); });

  const resizes: Array<{ c: number; r: number }> = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/term')) return;
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m.t === 'r') resizes.push({ c: m.c, r: m.r });
      } catch { /* not JSON — terminal input is still JSON, so this is defensive */ }
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

  // The socket has announced a size while the terminal font was still held.
  await expect.poll(() => resizes.length, { timeout: 15000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.fonts.check("12px 'MesloLGMDZ Nerd Font'"))).toBe(false);
  const rowsOf = () => screen.evaluate((el) => el.children.length);
  const rowsBefore = await rowsOf();

  // The fonts land; xterm re-measures and re-fits to a different row count.
  // Without that change the test would be vacuous, so it is asserted.
  released = true;
  for (const r of held) await r.continue();
  await page.waitForFunction(() => document.fonts.check("12px 'MesloLGMDZ Nerd Font'"), null, { timeout: 15000 });
  await expect.poll(rowsOf, { timeout: 15000 }).not.toBe(rowsBefore);
  const rowsAfter = await rowsOf();

  // The last size the client announced is the settled one, not the fallback's.
  await expect.poll(() => resizes[resizes.length - 1]?.r, { timeout: 5000 }).toBe(rowsAfter);

  // And tmux itself agrees with the glass: the client it is drawing for is as
  // tall as the rows xterm shows. Asked from inside the session rather than
  // assumed, as duplicatePanes.spec.ts does for the session name.
  await page.keyboard.type("clear; tmux display-message -p 'CLIENT_ROWS=#{client_height}'\n");
  await expect(screen).toContainText(`CLIENT_ROWS=${rowsAfter}`, { timeout: 15000 });
});
