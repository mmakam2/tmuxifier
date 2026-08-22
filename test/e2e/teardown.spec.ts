import { test, expect } from '@playwright/test';

// Session-expiry teardown and header layout — the three things shipped in
// v1.22.4 and v1.23.0 that no test could reach, because they are DOM lifecycle
// and geometry rather than logic. Verified here rather than left to an eyeball,
// since an eyeball does not fail a build when someone regresses it.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

// Expire the session the way a timeout does, from the client's point of view:
// posting logout through the page's own cookie jar advances the server-side
// revocation watermark and clears the cookie, so the page's next authenticated
// request 401s while the page itself still believes it is signed in.
async function expireSession(page) {
  const res = await page.request.post('/api/logout');
  expect(res.status()).toBe(200);
}

// B5. onUnauthorized used to tear panes down via closeTab(), which reaches
// undockBox -> repaintStage -> persistStage() and therefore OVERWROTE the saved
// split — the one thing the logout path goes out of its way to preserve. Removing
// the last pane also re-entered repaintStage's empty-stage branch, remounting the
// dashboard and restarting its 10s poll AFTER teardown, so 401s kept firing on the
// login screen until re-login.
test('an expired session preserves the persisted split and stops polling', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);

  const saved = await page.evaluate(() => localStorage.getItem('tmuxifier.stageLayout'));
  expect(saved).toBeTruthy();

  await expireSession(page);

  const apiCalls: string[] = [];
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/api/')) apiCalls.push(p);
  });

  // Any authenticated action now 401s and triggers the teardown. Reconnect is
  // arm-then-fire, so it takes two clicks.
  const cap = page.locator('.pane-header .pane-refresh').first();
  await cap.click();
  await cap.click();

  await expect(page.locator('#pw')).toBeVisible({ timeout: 20000 });

  // The split and its ratios must survive. focusedId is deliberately excluded:
  // the click that triggered the 401 focused that pane, which is correct behaviour
  // — what the 401 path used to destroy was the layout itself.
  const layoutOf = (raw: string | null) => { const p = JSON.parse(raw!); return JSON.stringify(p.root); };
  const after = await page.evaluate(() => localStorage.getItem('tmuxifier.stageLayout'));
  expect(layoutOf(after)).toBe(layoutOf(saved));

  // Nothing may poll from the login screen.
  apiCalls.length = 0;
  await page.waitForTimeout(3000);
  expect(apiCalls.filter((p) => p === '/api/services' || p === '/api/status')).toEqual([]);

  // And the layout genuinely comes back, which is the point of preserving it.
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 20000 });
});

// C2. The four settings-tab fetch layers (proxmox, netbox, passkeys, voice) each
// hand-rolled their own throw-on-not-ok pair and never reached api.ts's 401 seam,
// so an expired session hit them and the app went on believing it was signed in:
// a generic error toast, the dashboard frozen at its last paint, and — for the
// voice install poller — a 401 every 2s forever (B6).
//
// The unit tests prove the seam fires; this proves the whole chain, because the
// symptom was never the throw. It was that nothing downstream reacted to it.
// NetBox is the tab under test: it loads through nbx.get() on open, needs no
// fixture, and is one of the four layers that was bypassing the seam.
// The background pollers all go through api.ts, which HAS had the seam all
// along — so with them running this test passes even when netbox.ts bypasses it,
// just 10s later instead of 300ms (the dashboard tick). Verified by mutation:
// restoring the hand-rolled bypass kept it green until these were silenced.
// They are answered with healthy bodies rather than aborted, so the only 401 the
// page can possibly observe is the one the settings tab makes.
async function silenceBackgroundPolls(page) {
  await page.route('**/api/status**', (r) => r.fulfill({ json: {} }));
  await page.route('**/api/services', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/services/status**', (r) => r.fulfill({ json: {} }));
}

test('an expired session detected by a settings tab tears the workspace down', async ({ page }) => {
  await login(page);
  await silenceBackgroundPolls(page);
  await expireSession(page);

  // The gear opens on the NetBox tab, so nbx.get() fires on open — no tab click
  // (which would race the teardown this test is waiting for).
  await page.click('#settings');

  // The 401 from nbx.get() must route to the login screen, and take the
  // body-mounted settings modal with it — a modal left floating over the login
  // screen with live controls is the B11 shape. The timeout is well inside the
  // 30s status poll, the only seam-wired caller left: nothing but the settings
  // tab can produce this within the window.
  await expect(page.locator('#pw')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('.settings-modal')).toHaveCount(0);
});

// B11 is NOT covered here, deliberately. Every one of the five modals needs a
// fixture this suite does not have: the passkey dialogs are disabled because
// passkeys pin to `localhost` while the e2e origin is `127.0.0.1`, and the
// deprovision and add-disk dialogs need a Proxmox host profile with a linked
// container. It is pinned instead by test/modalRegistration.test.js, which asserts
// the invariant at every openModal call site rather than demonstrating one — a
// better fit for a bug that was five call sites forgetting the same line.

// v1.23.0 replaced the lifecycle glyphs with words (START/SHUTDOWN/REBOOT/STOP)
// because the reboot arrow was indistinguishable from Reconnect's. The open risk
// was width: four panes means quarter-width headers already carrying dot, label,
// host and a state chip. The cap now carries BOTH faces and CSS chooses, so this
// walks all three rungs of the ladder rather than the two it used to.
//
// The e2e fixture has no Proxmox host, so no pane renders lifecycle keys — the
// caps are injected with the real markup and classes, which since the two-face
// change means the real CHILD SPANS too: injecting bare text would leave the
// collapse rules matching nothing and quietly assert about markup the app does
// not ship. That is deliberate: the question is whether the CSS holds at each
// width, not whether the data plumbing works (paneLifecycle's own tests cover
// that, including which mark each action carries).
test('lifecycle caps walk the ladder: words, then marks, then gone — never squeezed', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);

  const measure = () => page.evaluate(() => {
    // Mirrors paint() in paneLifecycle.ts: a word span and a mark span, both
    // always present, with style.css deciding which is shown.
    const KEYS = [['shutdown', 'SHUTDOWN', '\uf011'], ['reboot', 'REBOOT', '\uf021'], ['stop', 'STOP', '\uf04d']];
    document.querySelectorAll('.pane-header').forEach((header) => {
      const slot = header.querySelector('.pane-lifecycle-slot');
      if (!slot || slot.childElementCount) return;
      for (const [action, word, mark] of KEYS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `pane-life pane-life-${action}${action === 'stop' ? ' danger' : ''}`;
        const w = document.createElement('span');
        w.className = 'pane-life-word';
        w.textContent = word;
        const i = document.createElement('span');
        i.className = 'pane-life-icon';
        i.textContent = mark;
        b.append(w, i);
        slot.appendChild(b);
      }
    });
    const shown = (e: Element | null) => !!e && getComputedStyle(e).display !== 'none';
    return [...document.querySelectorAll('.pane-header')].map((header) => {
      const el = header as HTMLElement;
      const id = header.querySelector('.pane-header-id') as HTMLElement;
      const slot = header.querySelector('.pane-lifecycle-slot') as HTMLElement | null;
      const caps = [...header.querySelectorAll('.pane-life')] as HTMLElement[];
      const picker = header.querySelector('.session-picker') as HTMLElement | null;
      return {
        header: Math.round(el.clientWidth),
        idOverflow: id.scrollWidth - id.clientWidth,
        capsShown: !!slot && getComputedStyle(slot).display !== 'none',
        wordsShown: caps.filter((c) => shown(c.querySelector('.pane-life-word'))).length,
        marksShown: caps.filter((c) => shown(c.querySelector('.pane-life-icon'))).length,
        capWidths: caps.map((c) => Math.round(c.getBoundingClientRect().width)),
        pickerWidth: picker ? Math.round(picker.getBoundingClientRect().width) : null,
        // A cap squeezed under its own content is the overlap bug: scrollWidth
        // exceeds clientWidth while the content spills instead of clipping.
        squeezed: caps.filter((c) => c.scrollWidth - c.clientWidth > 1).length,
      };
    });
  });

  // Rung 0 — a full-stage header: three words, at full size, nothing overflowing.
  await page.setViewportSize({ width: 1920, height: 900 });
  const wide = await measure();
  expect(wide[0].header, 'the wide case must actually be wide').toBeGreaterThan(560);
  expect(wide[0].capsShown).toBe(true);
  expect(wide[0].wordsShown, 'words carry the wide face').toBe(3);
  expect(wide[0].marksShown, 'marks stay in reserve while words fit').toBe(0);
  expect(wide[0].squeezed).toBe(0);
  expect(wide[0].idOverflow).toBeLessThanOrEqual(1);

  // Rung 1 — two panes: too narrow for three words, wide enough for three marks.
  // The caps collapse instead of clipping, and the session picker must not have
  // paid for it: it holds the width it had at full stage.
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await page.setViewportSize({ width: 1280, height: 800 });
  const mid = await measure();
  for (const row of mid) {
    expect(row.header, 'the mid case must sit between the rungs').toBeLessThanOrEqual(560);
    expect(row.header).toBeGreaterThan(400);
    expect(row.capsShown, `caps gone from a ${row.header}px header`).toBe(true);
    expect(row.wordsShown, `words still drawn in a ${row.header}px header`).toBe(0);
    expect(row.marksShown, `marks missing from a ${row.header}px header`).toBe(3);
    expect(row.capWidths.every((w) => w === 20), `collapsed caps are ${row.capWidths}`).toBe(true);
    expect(row.squeezed, `${row.squeezed} cap(s) squeezed at ${row.header}px`).toBe(0);
    expect(row.idOverflow, `identity group overflows by ${row.idOverflow}px at ${row.header}px`).toBeLessThanOrEqual(1);
    if (row.pickerWidth !== null && wide[0].pickerWidth !== null) {
      expect(row.pickerWidth, 'the picker paid for the caps').toBe(wide[0].pickerWidth);
    }
  }

  // Rung 3 — three panes: even the marks go, rather than print over the chip
  // and the mic button.
  await page.getByRole('button', { name: 'Dock untagged-worker beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(3);
  const narrow = await measure();
  for (const row of narrow) {
    expect(row.header, 'the narrow case must actually be narrow').toBeLessThan(400);
    expect(row.capsShown, `caps still shown in a ${row.header}px header`).toBe(false);
    expect(row.idOverflow, `identity group overflows by ${row.idOverflow}px at ${row.header}px`).toBeLessThanOrEqual(1);
  }

  // And the words come back when there is room again.
  await page.setViewportSize({ width: 1920, height: 900 });
  const roomy = await measure();
  for (const row of roomy) {
    expect(row.capsShown, `caps missing from a ${row.header}px header`).toBe(true);
    expect(row.squeezed, `${row.squeezed} cap(s) squeezed at ${row.header}px`).toBe(0);
    expect(row.idOverflow, `identity group overflows by ${row.idOverflow}px at ${row.header}px`).toBeLessThanOrEqual(1);
  }

  await page.screenshot({ path: 'test-results/pane-lifecycle-ladder.png' });
});
