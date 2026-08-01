import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// Two machines watching one box, which is the setup that reported smeared and
// duplicated characters. Tmuxifier used to key a box's PTY by box id alone, so
// both browsers shared ONE ssh and ONE `tmux attach`: a single screen, drawn at
// a single size, with whichever client resized last deciding that size. The
// viewer with the smaller window then received cursor moves past its own last
// row and column and rendered garbage.
//
// Separate browser contexts are what makes this a real reproduction rather than
// two tabs — each gets its own storage, so each mints its own viewer id, the
// same as two machines would.

async function openBox(page: Page): Promise<void> {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
}

test('two viewers of one box each get their own attach and their own size', async ({ browser }) => {
  const small: BrowserContext = await browser.newContext({ viewport: { width: 640, height: 480 } });
  const large: BrowserContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const socketsSmall: string[] = [];
  const socketsLarge: string[] = [];

  try {
    const a = await small.newPage();
    const b = await large.newPage();
    a.on('websocket', (ws) => { if (ws.url().includes('/term')) socketsSmall.push(ws.url()); });
    b.on('websocket', (ws) => { if (ws.url().includes('/term')) socketsLarge.push(ws.url()); });

    await openBox(a);
    await openBox(b);

    // Distinct viewer ids — the server keys a PTY per viewer off this, so the
    // same value from both would put them back on one shared screen.
    const idOf = (url: string) => new URL(url).searchParams.get('client');
    expect(idOf(socketsSmall[0])).toBeTruthy();
    expect(idOf(socketsSmall[0])).not.toBe(idOf(socketsLarge[0]));

    // They really are rendering at different sizes; without that this proves
    // nothing. Measured from the DOM rather than the socket URL, which only
    // carries the pre-fit 80x24 default — the fitted size follows as a resize
    // message once the webfonts settle and the cell metrics are known.
    const widthOf = async (p: Page) => (await p.locator('.xterm-screen').first().boundingBox())!.width;
    expect(await widthOf(b)).toBeGreaterThan(await widthOf(a));

    // Both are live views of the SAME tmux session, so a command typed on one
    // machine shows up on the other — separate attaches, one session.
    await a.keyboard.type('echo MULTI_VIEWER_OK\n');
    await expect(a.locator('.xterm-rows').first()).toContainText('MULTI_VIEWER_OK', { timeout: 15000 });
    await expect(b.locator('.xterm-rows').first()).toContainText('MULTI_VIEWER_OK', { timeout: 15000 });

    // And the small viewer is still a working terminal rather than a smeared
    // one — it can drive the session itself.
    await b.keyboard.type('echo SECOND_VIEWER_OK\n');
    await expect(b.locator('.xterm-rows').first()).toContainText('SECOND_VIEWER_OK', { timeout: 15000 });
    await expect(a.locator('.xterm-rows').first()).toContainText('SECOND_VIEWER_OK', { timeout: 15000 });
  } finally {
    await small.close();
    await large.close();
  }
});
