import { test, expect, type Page } from '@playwright/test';

// Phone mode end to end: the drawer shell, the single-pane stage with its
// top-bar switcher, and the touch key bar reaching the pty. Runs under the
// Pixel 5 device profile (see playwright.config.ts) — 393px wide, touch on,
// which is what makes both the `max-width: 720px` and the `pointer: coarse`
// halves of the phone CSS match. Geometry for the key bar itself lives in
// touchBar.spec.ts, which runs in this same project.

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  // The phone bar is the phone-mode tell: it exists in the DOM at every width
  // but only displays under the breakpoint.
  await expect(page.locator('#phone-menu')).toBeVisible({ timeout: 10000 });
}

// Idempotent: the open drawer is fixed and opaque and covers the ☰ that opened
// it, so a second tap is swallowed by the drawer rather than toggling it shut.
async function openDrawer(page: Page) {
  const layout = page.locator('.layout');
  if (!(await layout.evaluate((el) => el.classList.contains('drawer-open')))) await page.click('#phone-menu');
  await expect(layout).toHaveClass(/drawer-open/);
}

async function openLocalhost(page: Page) {
  await openDrawer(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.layout')).not.toHaveClass(/drawer-open/);
  const pane = page.locator('.stage-pane');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  // Every seeded box attaches the SAME tmux session (global-setup gives all
  // three the fixture's session name), and tmux sizes a window to its most
  // recent client — so a ~40-column phone attach re-wraps whatever the last
  // desktop client left on the input line. Clearing it means the assertions
  // below read a line this test wrote, not a rewrapped remnant of another one.
  await page.keyboard.press('Control+U');
  return pane;
}

test('drawer opens, box opens one full pane, drawer closes on pick', async ({ page }) => {
  await login(page);
  await expect(page.locator('.phone-bar')).toBeVisible();
  // Closed, the drawer is off-canvas and out of the tab order — the box list is
  // unreachable until the ☰ opens it.
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeHidden();
  await openDrawer(page);
  await openLocalhost(page);
});

test('a desktop split renders as ONE pane; switcher swaps without reconnecting', async ({ page }) => {
  await login(page);

  // Box ids are minted at import, so the layout has to be seeded from the ids
  // the running server actually holds. page.request rides the page's own cookie
  // jar, so this is an authenticated read.
  const boxes = await (await page.request.get('/api/boxes')).json();
  const idOf = (label: string) => {
    const b = boxes.find((x: { label: string }) => x.label === label);
    expect(b, `seeded box ${label} missing`).toBeTruthy();
    return b.id as string;
  };
  const [first, second] = [idOf('localhost'), idOf('db-primary')];

  // The shape serialize() writes (stageLayout.ts): { v, root, focusedId }, with
  // a split node of { orientation, children, ratios }. Written before the
  // reload because renderDashboard reads the key once, up front, and every
  // repaint after that writes it back.
  await page.evaluate(([a, b]) => {
    localStorage.setItem('tmuxifier.stageLayout', JSON.stringify({
      v: 2,
      root: { orientation: 'row', children: [a, b], ratios: [0.5, 0.5] },
      focusedId: a,
    }));
  }, [first, second]);

  // Every /term socket this page opens from here on. A switch that reconnected
  // would show up as an extra one; parking the pane instead of tearing it down
  // is the whole point.
  const sockets: string[] = [];
  page.on('websocket', (ws) => { if (ws.url().includes('/term')) sockets.push(ws.url()); });

  await page.reload();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  // The two-pane split survives in the model — only ONE pane is rendered, and
  // only that pane connects.
  expect(sockets).toHaveLength(1);

  const sw = page.locator('#phone-switch');
  await expect(sw).toBeEnabled();
  await expect(sw).toHaveValue(first);
  await expect(sw.locator('option')).toHaveCount(2);

  await sw.selectOption({ index: 1 });
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  expect(sockets, 'switching to the second pane connects it once').toHaveLength(2);

  await sw.selectOption(first);
  // Back on the first pane with no new socket: it was parked, still attached.
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 5000 });
  expect(sockets, 'switching back must reuse the parked terminal').toHaveLength(2);
});

test('key bar: esc reaches the pty, sticky ctrl+c interrupts', async ({ page }) => {
  await login(page);
  const pane = await openLocalhost(page);
  const cap = (id: string) => page.locator(`#touch-keys button[aria-label="${id}"]`);

  // cat -v renders control bytes visibly, so a tap on the bar's esc key is
  // observable as ^[ rather than as an invisible byte we have to take on faith.
  await page.keyboard.type('cat -v');
  await page.keyboard.press('Enter');
  await cap('esc').dispatchEvent('pointerdown');
  await page.keyboard.press('Enter');
  await expect(pane).toContainText('^[', { timeout: 10000 });

  // Sticky ctrl: the cap arms, the next soft-keyboard character is masked into
  // its control byte, and the cap disarms on use (transformInput repaints it).
  await cap('ctrl').dispatchEvent('pointerdown');
  await expect(cap('ctrl')).toHaveClass(/armed/);
  await page.keyboard.type('c');
  await expect(cap('ctrl'), 'the modifier is spent by the character it masked').not.toHaveClass(/armed/);

  // ^C ended cat, so the shell is reading again.
  await page.keyboard.type('echo PHONE_E2E_DONE');
  await page.keyboard.press('Enter');
  await expect(pane).toContainText('PHONE_E2E_DONE', { timeout: 10000 });
});

test('phone chrome is media-query gated: invisible at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  // The sidebar is a sidebar again, not a drawer — reachable with no ☰ tap.
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.phone-bar')).toBeHidden();
  await expect(page.locator('#touch-keys')).toBeHidden();
});
