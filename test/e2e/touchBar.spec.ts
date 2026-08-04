import { test, expect, type Page } from '@playwright/test';

// The touch key bar, measured at real phone widths. This suite exists because
// "the mic does not render" shipped twice in a row and neither time did any
// automated test notice: first the adopted button kept its absolute
// floating-over-canvas geometry and painted over the phone bar, then — once
// that was fixed — the bar's own horizontal scroller pushed it past the right
// edge of every phone viewport, reachable only by a swipe nothing advertises.
//
// toBeVisible() catches NEITHER of those: an element scrolled off-screen inside
// an overflow container is still "visible" to Playwright. So these assert
// GEOMETRY — where the button actually is, in viewport coordinates.
//
// `hasTouch` is load-bearing: the bar is gated on `(pointer: coarse)`, so
// without it the media query never matches and there is no bar to measure.

async function openOnPhone(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  // At phone width the sidebar is a slide-over drawer, so the box row is not
  // reachable until the menu opens it.
  await page.click('#phone-menu');
  const localhost = page.locator('.box .name', { hasText: 'localhost' });
  await expect(localhost).toBeVisible({ timeout: 10000 });
  await localhost.click();
  await expect(page.locator('.xterm-rows').first()).toContainText(/[#$%>]/, { timeout: 15000 });
  // Every seeded box attaches the same tmux session, and tmux sizes a window to
  // its most recent client — so a ~40-column phone attach re-wraps whatever the
  // last desktop client left on the input line. Clear it.
  await page.keyboard.press('Control+U');
}

// iPhone SE / 14 / 14 Pro Max logical widths — the narrow, common and wide ends.
for (const width of [360, 390, 430]) {
  test.describe(`touch key bar at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });

    test('the mic stays on screen and keeps its touch target', async ({ page }) => {
      await openOnPhone(page);
      await expect(page.locator('.touch-keys')).toBeVisible({ timeout: 10000 });

      const mic = page.locator('.voice-btn');
      await expect(mic).toBeVisible({ timeout: 10000 });
      const box = await mic.boundingBox();
      expect(box).not.toBeNull();

      // Wholly within the viewport — the regression that shipped twice.
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      // Still a thumb target, not the 11px floating chip.
      expect(box!.height).toBeGreaterThanOrEqual(36);

      // In the bar, not merely on the screen. The round-1 defect kept the
      // button's `position: absolute; top: 6px; right: 12px` and, with no
      // positioned ancestor, painted it against the viewport — over the phone
      // bar at the TOP of the screen. Every assertion above still passed.
      const bar = await page.locator('#touch-keys').boundingBox();
      expect(bar).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(bar!.x - 1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(bar!.x + bar!.width + 1);
      expect(box!.y).toBeGreaterThanOrEqual(bar!.y - 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(bar!.y + bar!.height + 1);
    });

    test('the caps scroll inside their own strip, not the bar', async ({ page }) => {
      await openOnPhone(page);
      const caps = page.locator('.touch-caps');
      await expect(caps).toBeVisible({ timeout: 10000 });

      // The cap strip is wider than the space it gets, and that overflow is
      // confined to this child: if it were on .touch-keys the mic would ride
      // off the right edge with it. Clipping a cap is fine — it scrolls.
      const metrics = await caps.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);

      const bar = await page.locator('.touch-keys').evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
    });

    // The bar's mic override once carried a flat `opacity: 1`, whose 0-3-0
    // outranked `.voice-btn:disabled` (0-2-0) and `[data-state='working']`
    // — so a mic disabled for an insecure context looked live and did nothing
    // when tapped. Geometry tests cannot see that; only the cascade can. The
    // buttons are synthesized because the states are otherwise unreachable
    // here (the e2e server has voice ON and a secure enough context), and CSS
    // does not care who created the element.
    test('the mic dims for its disabled and working states', async ({ page }) => {
      await openOnPhone(page);
      await expect(page.locator('.touch-mic-slot')).toBeVisible({ timeout: 10000 });
      const opacity = await page.locator('.touch-mic-slot').evaluate((slot) => {
        const read = (f: (b: HTMLButtonElement) => void) => {
          const b = document.createElement('button');
          b.className = 'voice-btn';
          f(b);
          slot.appendChild(b);
          const o = getComputedStyle(b).opacity;
          b.remove();
          return o;
        };
        return {
          idle: read(() => {}),
          disabled: read((b) => { b.disabled = true; }),
          working: read((b) => { b.dataset.state = 'working'; }),
          recording: read((b) => { b.dataset.state = 'recording'; }),
        };
      });
      expect(opacity).toEqual({ idle: '1', disabled: '0.3', working: '0.7', recording: '1' });
    });

    test('the enter cap is pinned on screen, outside the scroller', async ({ page }) => {
      await openOnPhone(page);
      const enter = page.locator('.touch-keys > button[aria-label="enter"]');
      await expect(enter).toBeVisible({ timeout: 10000 });
      const box = (await enter.boundingBox())!;
      // Wholly within the viewport — the exact failure the old last-in-strip
      // position had. Geometry, not toBeVisible(): an element scrolled off
      // inside an overflow container is still "visible" to Playwright.
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(36); // still a thumb target
      // Structurally out of the scroller, so no future reflow can pull it back in.
      expect(await page.locator('.touch-caps button[aria-label="enter"]').count()).toBe(0);
    });
  });
}
