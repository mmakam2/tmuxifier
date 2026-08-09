import { test, expect, type Page } from '@playwright/test';

// The themes engine end to end: the Appearance picker switches live, the choice
// persists SERVER-side (data/ui-settings.json — not this browser), and the
// localStorage mirror lets public/theme-boot.js paint the login screen before
// any session or bundle exists.
//
// Suite hygiene: the pref is server-global and the e2e server is shared by every
// spec (workers: 1), so this file MUST hand Instrument back before it finishes —
// the closing assertions are that proof, not a formality. A navy app would
// otherwise leak into every spec that runs after it.

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

// The radio's onchange applies the theme locally and PATCHes fire-and-forget, so
// waiting for that response is load-bearing: without it the reload below would
// race the very request whose effect it asserts.
async function pickTheme(page: Page, label: string) {
  await page.click('#settings');
  await page.click('.pve-tabs button:has-text("Appearance")');
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/ui-settings') && r.request().method() === 'PATCH' && r.ok(),
    { timeout: 10000 },
  );
  await page.click(`.appearance-row:has-text("${label}") input[name="ui-theme"]`);
  await saved;
  await page.keyboard.press('Escape'); // close the settings modal
}

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// Belt and braces. The in-test restore below is the contract and is asserted;
// this only covers the case where an assertion FAILS before reaching it, which
// would otherwise strand the shared server on Original for every spec that runs
// after this file (observed while red-green checking these assertions). Silent
// and best-effort: it must never turn a run red on its own, and it re-logs-in
// because the test deliberately clears its own cookies part way through.
test.afterEach(async ({ page }) => {
  try {
    await page.request.post('/api/login', { data: { password: 'e2e' } });
    await page.request.patch('/api/ui-settings', { data: { theme: 'instrument' } });
  } catch { /* the assertions in the test are the real proof */ }
});

test('theme switches live, persists server-side, and paints pre-auth via the mirror', async ({ page }) => {
  await login(page);
  // Precondition — and the state this test owes the rest of the suite: the
  // default theme carries no attribute, because :root's own tokens ARE Instrument.
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  const bgBefore = await bodyBg(page);

  await pickTheme(page, 'Original');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'original');
  // Beyond the attribute: the body must actually repaint. This is what proves the
  // themes/original.css side-effect import shipped in the bundle — a dropped
  // import leaves the attribute stamped and every colour unchanged.
  const bgAfter = await bodyBg(page);
  expect(bgAfter).not.toBe(bgBefore);
  // The favicon is a real swapped asset (theme.ts applyFavicon), not CSS —
  // assert the link retargeted to the Original variant.
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /tmuxifier-logo-original/);

  // Server-persisted: a fresh load lands on Original again…
  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'original');

  // …and theme-boot.js stamps it from the mirror BEFORE login. Clear the session
  // cookie only (the mirror survives) and block the app bundle, so the blocking
  // head script is the only thing left that could have stamped <html> — with the
  // bundle loading, main.ts's own applyTheme() would mask a broken boot script.
  await page.context().clearCookies();
  let blockedBundles = 0;
  await page.route('**/assets/*.js', (route) => { blockedBundles += 1; return route.abort(); });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'original');
  expect(await bodyBg(page)).toBe(bgAfter); // the stylesheet followed, pre-paint
  expect(blockedBundles).toBeGreaterThan(0); // …and the bundle really was absent
  await page.unroute('**/assets/*.js');

  // With the bundle back, the logged-out login screen wears it too.
  await page.goto('/');
  await expect(page.locator('#pw')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'original');

  // Restore for the rest of the suite (shared server, workers: 1).
  await login(page);
  await pickTheme(page, 'Bench Instrument');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await bodyBg(page)).toBe(bgBefore);
  await expect(page.locator('link[rel="icon"]')).not.toHaveAttribute('href', /tmuxifier-logo-original/);
  // The restore has to reach the SERVER, not just this DOM — that is the copy
  // every later spec's browser reads at boot.
  const stored = await (await page.request.get('/api/ui-settings')).json();
  expect(stored.theme).toBe('instrument');
});

// A fresh browser must not invent a clawd preference on first boot. The server
// pref reads null ("never set") and nothing is mirrored locally, so main.ts
// leaves its cache unseeded rather than calling setClawdVariant — which
// PERSISTS, and whose mirror key the NEXT boot would read as a legacy pref and
// PATCH up as an explicit choice the operator never made.
test('a fresh browser boots without inventing a clawd preference', async ({ page }) => {
  // Playwright hands every test its own context, so this localStorage is clean —
  // and nothing here touches Appearance, which is the only surface that would
  // legitimately write the key.
  await login(page);
  expect(await page.evaluate(() => localStorage.getItem('tmuxifier.clawdAnim'))).toBeNull();

  // The reload is the load-bearing half, and deliberately not a formality: the
  // check above covers the fresh-login path through loadUiSettings(), while this
  // one covers the start() boot path where the phantom seed — and, on the boot
  // after it, the phantom PATCH it manufactured — actually lived.
  await page.reload();
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => localStorage.getItem('tmuxifier.clawdAnim'))).toBeNull();
  const stored = await (await page.request.get('/api/ui-settings')).json();
  expect(stored.clawdAnim).toBeNull();
});

// The server's theme must land on the FIRST authenticated paint, not one reload
// later. The ui-settings fetch used to live only in start(), which a login does
// not run — the submit handler transitions to the workspace without a page load
// — so a brand-new browser (no mirror for theme-boot.js to paint from) logged in
// wearing Instrument however the server was configured, and stayed that way
// until something reloaded the page.
test('a fresh login applies the server theme with no reload', async ({ page, browser }) => {
  // Arrange on the shared server via the API, so the assertions below are about
  // the login transition alone and not about a picker interaction.
  await page.request.post('/api/login', { data: { password: 'e2e' } });
  await page.request.patch('/api/ui-settings', { data: { theme: 'original' } });

  // A genuinely fresh browser: its own cookies AND its own empty localStorage,
  // which is what makes this the interesting case — with no mirror, the boot
  // script stamps nothing, so only the post-login fetch can supply the theme.
  const ctx = await browser.newContext();
  try {
    const fresh = await ctx.newPage();
    await fresh.goto('/');
    await expect(fresh.locator('#pw')).toBeVisible({ timeout: 10000 });
    await expect(fresh.locator('html')).not.toHaveAttribute('data-theme', /./);
    const bgLoggedOut = await bodyBg(fresh);

    await fresh.fill('#pw', 'e2e');
    await fresh.click('button:has-text("Unlock")');
    await expect(fresh.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });

    // No reload anywhere above this line.
    await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'original');
    expect(await bodyBg(fresh)).not.toBe(bgLoggedOut);
  } finally {
    await ctx.close();
  }

  // Restore for the rest of the suite (shared server, workers: 1).
  await page.request.patch('/api/ui-settings', { data: { theme: 'instrument' } });
  const stored = await (await page.request.get('/api/ui-settings')).json();
  expect(stored.theme).toBe('instrument');
});
