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
// host and a state chip.
//
// The e2e fixture has no Proxmox host, so no pane renders lifecycle keys — the
// caps are injected with the real markup and classes. That is deliberate: the
// question is whether the CSS fits three words in that space, not whether the
// data plumbing works (which paneLifecycle's own tests cover).
test('lifecycle word caps never overlap: full size when they fit, hidden when they do not', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(1);

  // The fixture has no Proxmox host, so no pane renders lifecycle keys on its own.
  // The caps are injected with the real markup and classes: the question is whether
  // the CSS holds, which paneLifecycle's unit tests cannot answer.
  const measure = () => page.evaluate(() => {
    const KEYS = [['shutdown', 'SHUTDOWN'], ['reboot', 'REBOOT'], ['stop', 'STOP']];
    document.querySelectorAll('.pane-header').forEach((header) => {
      const slot = header.querySelector('.pane-lifecycle-slot');
      if (!slot || slot.childElementCount) return;
      for (const [action, word] of KEYS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `pane-life pane-life-${action}${action === 'stop' ? ' danger' : ''}`;
        b.textContent = word;
        slot.appendChild(b);
      }
    });
    return [...document.querySelectorAll('.pane-header')].map((header) => {
      const el = header as HTMLElement;
      const id = header.querySelector('.pane-header-id') as HTMLElement;
      const slot = header.querySelector('.pane-lifecycle-slot') as HTMLElement | null;
      const caps = [...header.querySelectorAll('.pane-life')] as HTMLElement[];
      return {
        header: Math.round(el.clientWidth),
        idOverflow: id.scrollWidth - id.clientWidth,
        capsShown: !!slot && getComputedStyle(slot).display !== 'none',
        // A cap squeezed under its own text is the overlap bug: scrollWidth
        // exceeds clientWidth while the text spills instead of clipping.
        squeezed: caps.filter((c) => c.scrollWidth - c.clientWidth > 1).length,
      };
    });
  });

  // Wide: the caps show, at full size, with nothing overflowing.
  const wide = await measure();
  expect(wide[0].capsShown).toBe(true);
  expect(wide[0].squeezed).toBe(0);
  expect(wide[0].idOverflow).toBeLessThanOrEqual(1);

  // Narrow enough that three words plus an identity cannot coexist: the caps leave
  // rather than print over the chip and the mic button.
  await page.getByRole('button', { name: 'Dock db-primary beside current terminal' }).click();
  await page.getByRole('button', { name: 'Dock untagged-worker beside current terminal' }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(3);
  await page.setViewportSize({ width: 1280, height: 800 });

  const narrow = await measure();
  for (const row of narrow) {
    expect(row.header, 'the narrow case must actually be narrow').toBeLessThan(400);
    expect(row.capsShown, `caps still shown in a ${row.header}px header`).toBe(false);
    expect(row.idOverflow, `identity group overflows by ${row.idOverflow}px at ${row.header}px`).toBeLessThanOrEqual(1);
  }

  // And they come back when there is room again.
  await page.setViewportSize({ width: 1920, height: 900 });
  const roomy = await measure();
  for (const row of roomy) {
    expect(row.capsShown, `caps missing from a ${row.header}px header`).toBe(true);
    expect(row.squeezed, `${row.squeezed} cap(s) squeezed at ${row.header}px`).toBe(0);
    expect(row.idOverflow, `identity group overflows by ${row.idOverflow}px at ${row.header}px`).toBeLessThanOrEqual(1);
  }

  await page.screenshot({ path: 'test-results/pane-lifecycle-words.png' });
});
