import { test, expect } from '@playwright/test';

// The pane header's session/window picker, refreshed on demand, plus its
// per-row kill control.
//
// Its rows are rendered from the status snapshot, which is a server-side
// cache read on a client-side interval (30s each in production). A window
// opened on the box with `prefix-c` was therefore invisible here for up to a
// minute — and the current row went on naming a window that was no longer
// active — while the Edit Box modal, which probes live, showed it
// immediately. Reaching for the picker now re-probes that box first.
//
// This is the only level at which any of this can be tested: vitest runs
// without a DOM, so the pointer wiring in sessionPicker.ts has no unit-test
// seam.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('a window created on the box appears in the picker as it is reached for', async ({ page }) => {
  await login(page);

  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const picker = pane.locator('.session-picker');
  const trigger = picker.locator('.session-picker-trigger');
  await expect(trigger).toBeVisible();

  try {
    // Create a second window the way an operator does — from inside the session,
    // with nothing telling Tmuxifier it happened.
    await pane.click();
    await page.keyboard.type('tmux new-window -n e2ewin');
    await page.keyboard.press('Enter');
    await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

    // Reaching for the control is the trigger. The request assertion is the
    // non-vacuous half: without the on-demand probe there is no such request at
    // all, and the row below would arrive only on the next 30s client poll.
    const probed = page.waitForRequest(
      (r) => /\/api\/boxes\/[^/]+\/probe$/.test(r.url()) && r.method() === 'POST',
      { timeout: 10000 },
    );
    await trigger.hover();
    await probed;
    await trigger.click();

    await expect(picker.locator('.session-picker-pick', { hasText: 'e2ewin' })).toHaveCount(1, { timeout: 5000 });
    // The header still answers "which window am I looking at": tmux makes a new
    // window active, so the current row must have followed it there.
    await expect(picker.locator('.session-picker-row.current .session-picker-pick')).toContainText('e2ewin');
  } finally {
    // Leave the fixture's shared session as it was found — the suite runs
    // workers: 1 against one tmux session, so a stray window would follow
    // every later spec around, INCLUDING on a failure that aborts mid-
    // assertion above (a trailing statement never reached on that path). The
    // popup opened above moves focus onto its first row; clicking the pane
    // closes it (focus leaving the picker) and refocuses the terminal, so the
    // keystrokes below land in the shell rather than on a button — needed on
    // the failure path even more than the happy one, since the popup may
    // still be open there.
    await pane.click().catch(() => {});
    await page.keyboard.type('exit').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});

test('one click on × does not kill — arm-then-fire holds', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  // A throwaway session, so the fixture's shared one survives for later specs
  // (the suite runs workers: 1 against a single tmux server).
  await pane.click();
  await page.keyboard.type('tmux new-session -d -s e2ekill');
  await page.keyboard.press('Enter');

  try {
    const picker = pane.locator('.session-picker');
    await picker.locator('.session-picker-trigger').click();
    const row = picker.locator('.session-picker-row', { hasText: 'e2ekill' });
    await expect(row).toHaveCount(1, { timeout: 10000 });
    const kill = row.locator('.session-picker-kill');

    // Baseline, before anything is armed: a bare × with no armed class. Makes
    // the before/after contrast on the single most important assertion in
    // this file explicit, rather than only checking the "after" side.
    await expect(kill).not.toHaveClass(/armed/);
    await expect(kill).toHaveText('×');

    // First click ARMS. The row must still be there, and the cap must now state
    // its consequence rather than showing a bare ×.
    await kill.click();
    await expect(row.locator('.session-picker-kill.armed')).toHaveText(/kill/i);
    await expect(row).toHaveCount(1);

    // Second click commits.
    await kill.click();
    await expect(picker.locator('.session-picker-row', { hasText: 'e2ekill' })).toHaveCount(0, { timeout: 15000 });
  } finally {
    // If any assertion above threw before the committing click fired,
    // e2ekill would otherwise survive as a detached session for every later
    // spec (workers: 1, one shared tmux server). This goes straight at tmux
    // rather than back through the picker: if the picker itself is what's
    // broken (the thing this test exercises), the safety net can't depend on
    // it too. Best-effort and silent — it's a no-op once the row's own second
    // click has already committed the kill.
    await pane.click().catch(() => {});
    await page.keyboard.type('tmux kill-session -t e2ekill 2>/dev/null').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});

test('a poll landing while a row is armed does not move the arm', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  // A throwaway session, so the fixture's shared one survives for later specs
  // (the suite runs workers: 1 against one tmux session).
  await pane.click();
  await page.keyboard.type('tmux new-session -d -s e2earmpoll');
  await page.keyboard.press('Enter');

  try {
    const picker = pane.locator('.session-picker');
    await picker.locator('.session-picker-trigger').click();
    const row = picker.locator('.session-picker-row', { hasText: 'e2earmpoll' });
    await expect(row).toHaveCount(1, { timeout: 10000 });
    const key = await row.getAttribute('data-key');

    // Let the trigger's own freshness window (freshProbe.ts, main.ts's
    // freshMs: 3000) lapse from the open above BEFORE arming — not after.
    // Arming starts its OWN 3s clock (ARM_MS), so waiting here first (while
    // nothing is armed, so there is nothing to expire) means the hover below
    // lands well inside a freshly-armed row's window instead of racing its
    // own expiry. Waiting AFTER arming instead would just let the arm time
    // out on its own before the hover ever fires.
    await page.waitForTimeout(3600);

    // Arm this row's ×. The spec's own concern is a refresh landing BETWEEN
    // the arming click and the committing one — sessionPicker.ts holds any
    // list that arrives while a row is armed (`pendingList`) rather than
    // rebuilding rows out from under it, the arm-then-fire equivalent of the
    // stale-index bug that made this codebase address windows by @id instead
    // of index.
    const kill = row.locator('.session-picker-kill');
    await kill.click();
    await expect(row.locator('.session-picker-kill.armed')).toHaveCount(1);

    // Force a fresh probe underneath the still-open, still-armed popup, well
    // inside the arm's own 3s window. The wait above guarantees this reach is
    // outside the trigger's freshness window, so it is a genuinely NEW
    // request rather than served from cache with no request at all — without
    // that, the assertions below would pass vacuously regardless of whether
    // the guard in sessionPicker.ts actually held. This is what "a status
    // poll lands mid-arm" looks like from the widget's own point of view: any
    // picker.update() call carrying a fresh list while a row is armed — the
    // production 30s client poll exercises the identical code path but would
    // never fire within an e2e test's lifetime.
    const probed = page.waitForRequest(
      (r) => /\/api\/boxes\/[^/]+\/probe$/.test(r.url()) && r.method() === 'POST',
      { timeout: 10000 },
    );
    await picker.locator('.session-picker-trigger').hover();
    await probed;

    // The arm held: still exactly one armed row, and it is the SAME row —
    // not merely "some row is armed", which a refresh that reordered the
    // list and migrated the arm onto a different session would still satisfy.
    await expect(picker.locator('.session-picker-kill.armed')).toHaveCount(1, { timeout: 5000 });
    await expect(picker.locator(`.session-picker-row[data-key="${key}"] .session-picker-kill`)).toHaveClass(/armed/);
  } finally {
    // If any assertion above threw before the arm expired or was dismissed,
    // e2earmpoll would otherwise survive as a detached session for every
    // later spec (workers: 1, one shared tmux server). Straight at tmux, not
    // back through the picker, matching the neighbouring tests' own net.
    await pane.click().catch(() => {});
    await page.keyboard.type('tmux kill-session -t e2earmpoll 2>/dev/null').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});

test('killing a window removes it and leaves the session', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

  const picker = pane.locator('.session-picker');

  try {
    await pane.click();
    await page.keyboard.type('tmux new-window -n e2ekillwin');
    await page.keyboard.press('Enter');
    await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });

    // ONE open — one fresh probe — for the whole test. freshProbe.ts answers
    // a second reach within its 3s freshness window (main.ts's freshMs: 3000)
    // from the FIRST probe's (by then stale) result rather than hitting the
    // network again, so an
    // earlier separate open to pre-capture a "before" witness would starve
    // this one of the very refresh the assertions below depend on.
    await picker.locator('.session-picker-trigger').click();
    const row = picker.locator('.session-picker-row', { hasText: 'e2ekillwin' });
    await expect(row).toHaveCount(1, { timeout: 10000 });

    // The untouched sibling: any OTHER window row, visible in this same
    // opening. The session's OWN row is not a usable witness by itself:
    // sessionTargets() (paneHeader.ts) always emits the box's configured
    // session as a row, even when tmux no longer lists it at all ("always
    // present … even when tmux no longer lists it") — so a kill that wrongly
    // destroyed the WHOLE session instead of just the window (e.g. the route
    // ignoring windowId and running kill-session) would still leave exactly
    // that one placeholder row, and a bare "row count isn't 0" check would
    // pass regardless. A sibling WINDOW row can tell the two worlds apart:
    // sessionTargets() only attaches window rows to a session it finds live
    // in the current probe, so a dead session emits none at all.
    const siblingRow = picker.locator('.session-picker-row[data-key^="w:"]').filter({ hasNotText: 'e2ekillwin' });
    await expect(siblingRow).toHaveCount(1, { timeout: 10000 });
    const siblingKey = await siblingRow.getAttribute('data-key');

    const kill = row.locator('.session-picker-kill');
    await kill.click();
    await kill.click();

    await expect(picker.locator('.session-picker-row', { hasText: 'e2ekillwin' })).toHaveCount(0, { timeout: 15000 });
    // The sibling window survived: a wrong-scope kill that took the whole
    // session with it would have taken this row too (see above).
    await expect(picker.locator(`.session-picker-row[data-key="${siblingKey}"]`)).toHaveCount(1, { timeout: 10000 });
  } finally {
    // e2ekillwin surviving a failed assertion above would follow every later
    // spec (workers: 1, one shared tmux session). Straight at tmux, not back
    // through the picker, for the same reason as the arm-then-fire test's net
    // above. Resolves relative to the current session (no colon in the
    // target), matching how the test itself created the window; a no-op once
    // the row's own second click already committed the kill.
    await pane.click().catch(() => {});
    await page.keyboard.type('tmux kill-window -t e2ekillwin 2>/dev/null').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});
