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

const cap = (page: Page, id: string) => page.locator(`#touch-keys button[aria-label="${id}"]`);

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
  // The rows have to EXIST before their invisibility means anything: toBeHidden()
  // is satisfied by a locator matching nothing, and login() only waits for
  // #phone-menu, so the box list may still be a fetch away. Without this gate the
  // assertion below passes on an empty drawer — including one that never renders.
  await expect(page.locator('.box')).toHaveCount(3);
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
  // WHICH pane, not just how many. Every seeded box attaches the same tmux
  // session, so screen content cannot tell the two apart — the pane's own id
  // and the socket's `box=` parameter are the only exact signals available, and
  // without them this test would pass on a switcher that rendered the same box
  // twice.
  await expect(page.locator(`.stage-pane[data-pane-id="${first}"]`)).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  // The two-pane split survives in the model — only ONE pane is rendered, and
  // only that pane connects.
  expect(sockets).toHaveLength(1);
  expect(new URL(sockets[0]).searchParams.get('box')).toBe(first);

  const sw = page.locator('#phone-switch');
  await expect(sw).toBeEnabled();
  await expect(sw).toHaveValue(first);
  await expect(sw.locator('option')).toHaveCount(2);

  await sw.selectOption({ index: 1 });
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator(`.stage-pane[data-pane-id="${second}"]`)).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  expect(sockets, 'switching to the second pane connects it once').toHaveLength(2);
  expect(new URL(sockets[1]).searchParams.get('box')).toBe(second);

  await sw.selectOption(first);
  // Back on the first pane with no new socket: it was parked, still attached.
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(page.locator(`.stage-pane[data-pane-id="${first}"]`)).toHaveCount(1);
  await expect(page.locator('.stage-pane .xterm-rows')).toContainText(/[#$%>]/, { timeout: 5000 });
  expect(sockets, 'switching back must reuse the parked terminal').toHaveLength(2);
});

test('key bar: esc reaches the pty, sticky ctrl+c interrupts', async ({ page }) => {
  await login(page);
  const pane = await openLocalhost(page);
  // The bar's whole reason for using pointerdown + preventDefault is that a
  // normal click would move focus off xterm's hidden textarea and dismiss the
  // soft keyboard on every key press. Asserted directly, because the keyboard
  // steps below only detect a steal indirectly.
  const focusInPane = () => page.evaluate(() => !!document.activeElement?.closest('.stage-pane'));

  try {
    // cat -v renders control bytes visibly, so a tap on the bar's esc key is
    // observable as ^[ rather than as an invisible byte we have to take on faith.
    await page.keyboard.type('cat -v');
    await page.keyboard.press('Enter');
    // tap(), not dispatchEvent('pointerdown'): a synthetic dispatch has no
    // default action to prevent, so preventDefault() could be deleted (or the
    // handlers moved to 'click') without failing anything. A real tap runs the
    // browser's own touch → pointerdown → mousedown → focus sequence, which is
    // the thing the handler exists to interrupt.
    await cap(page, 'esc').tap();
    await expect.poll(focusInPane, { message: 'the esc cap stole focus from the terminal' }).toBe(true);
    await page.keyboard.press('Enter');
    await expect(pane).toContainText('^[', { timeout: 10000 });

    // Sticky ctrl: the cap arms, the next soft-keyboard character is masked into
    // its control byte, and the cap disarms on use (transformInput repaints it).
    await cap(page, 'ctrl').tap();
    await expect(cap(page, 'ctrl')).toHaveClass(/armed/);
    await expect.poll(focusInPane, { message: 'the ctrl cap stole focus from the terminal' }).toBe(true);
    await page.keyboard.type('c');
    await expect(cap(page, 'ctrl'), 'the modifier is spent by the character it masked').not.toHaveClass(/armed/);

    // The INTR byte reached the tty: ECHOCTL prints it. This is the only direct
    // evidence in the test that \x03 arrived rather than a plain 'c'.
    await expect(pane).toContainText('^C', { timeout: 10000 });

    // And it was delivered as a SIGNAL, not merely echoed — cat is gone and the
    // SHELL is reading again. The quotes are load-bearing: with cat -v still in
    // the foreground the screen would show `echo PHONE''_DONE` twice (tty echo,
    // then cat's own copy) and never the collapsed `PHONE_DONE`, which only the
    // shell can produce. A plain `echo X` would have matched either way, since
    // cat happily echoes the command line back.
    await page.keyboard.type("echo PHONE''_DONE");
    await page.keyboard.press('Enter');
    await expect(pane).toContainText('PHONE_DONE', { timeout: 10000 });
  } finally {
    // Never leave `cat -v` holding the shared session's tty on a failure path:
    // every other spec in both projects attaches this same tmux session, and a
    // foreground reader there would swallow their input. A real Ctrl+C, not the
    // bar's sticky one — this has to work even when the bar is what failed.
    await page.keyboard.press('Control+C').catch(() => {});
  }
});

test('a cap fires from the keyboard, not only from a finger', async ({ page }) => {
  await login(page);
  await openLocalhost(page);
  try {
    const ctrl = cap(page, 'ctrl');
    await ctrl.focus();
    // preventDefault() on pointerdown suppresses the click a POINTER gesture
    // would synthesize — which also left these caps dead to Enter, Space and to
    // any assistive technology that activates a control rather than pointing at
    // it. A keyboard-originated click carries detail 0, which is what the bar
    // discriminates on, so this must fire without double-firing a tap.
    await page.keyboard.press('Enter');
    await expect(ctrl, 'Enter on a focused cap must arm sticky ctrl').toHaveClass(/armed/);
    await page.keyboard.press('Enter');
    await expect(ctrl, 'and a second Enter must toggle it back off').not.toHaveClass(/armed/);
  } finally {
    await page.keyboard.press('Control+C').catch(() => {});
  }
});

test('an armed ctrl does not survive a logout', async ({ page }) => {
  await login(page);
  // No pane docked, deliberately. With one docked, re-login reopens it and
  // tmux's focus-in report (\x1b[I) reaches transformInput first — unmaskable,
  // so it passes through untouched but SPENDS the modifier, hiding the very bug
  // this asserts. The bare dashboard is both the honest path and the real one:
  // the user logs back in, THEN opens a box, then types.
  await page.evaluate(() => localStorage.removeItem('tmuxifier.stageLayout'));
  await page.reload();
  await expect(page.locator('#phone-menu')).toBeVisible({ timeout: 10000 });

  await cap(page, 'ctrl').tap();
  await expect(cap(page, 'ctrl')).toHaveClass(/armed/);

  await openDrawer(page);
  await page.click('#logout');
  await expect(page.locator('#pw')).toBeVisible({ timeout: 10000 });
  await login(page);

  // The modifier is module-level in main.ts and outlives the bar #app drops, so
  // without teardownWorkspace disarming it the next login's first typed
  // character would be masked — `d` arriving as ^D and closing the shell — with
  // a freshly built, unlit cap giving no clue why. Asserted BEFORE any keystroke,
  // since sticky.transform spends the modifier on whatever arrives first.
  await expect(
    cap(page, 'ctrl'),
    'an armed ctrl must not survive teardownWorkspace',
  ).not.toHaveClass(/armed/);
  await expect(cap(page, 'ctrl')).toHaveAttribute('aria-pressed', 'false');
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

test('touch drag on the terminal scrolls the pty instead of panning the page', async ({ page }) => {
  await login(page);
  const pane = await openLocalhost(page);
  // cat -v echoes control bytes: an upward drag must arrive as down-arrows
  // (ESC [ B → ^[[B) — the same sequences a desktop wheel produces at
  // scrollback 0 — and the touchmove must be cancelled, because an
  // unconsumed pan at page top is the browser's pull-to-refresh gesture.
  await pane.click();
  await page.keyboard.type('cat -v');
  await page.keyboard.press('Enter');
  try {
    const cancelled = await page.evaluate(() => {
      const screen = document.querySelector('.stage-pane .xterm-screen') as HTMLElement;
      const rect = screen.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const mk = (type: string, y: number) => {
        const touch = new Touch({ identifier: 1, target: screen, clientX: x, clientY: y, pageX: x, pageY: y });
        return new TouchEvent(type, { touches: [touch], changedTouches: [touch], bubbles: true, cancelable: true });
      };
      const startY = rect.y + rect.height / 2;
      screen.dispatchEvent(mk('touchstart', startY));
      const move = mk('touchmove', startY - 60); // finger up = scroll down
      screen.dispatchEvent(move);
      return move.defaultPrevented;
    });
    await expect(page.locator('.stage-pane .xterm-rows')).toContainText('^[[B', { timeout: 10000 });
    expect(cancelled, 'touchmove must be cancelled or the browser pans (pull-to-refresh)').toBe(true);
  } finally {
    // End cat so the shared session is at a prompt for whatever runs next.
    await page.locator('.stage-pane').click();
    await cap(page, 'ctrl').tap();
    await page.keyboard.type('c');
  }
});
