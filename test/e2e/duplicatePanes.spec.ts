import { test, expect } from '@playwright/test';

// Duplicate panes: the dock (◫) button on a docked box docks a SECOND pane of
// the same box — adopting a live unshown session when one exists, creating
// `<name>-2` when dry — and the header dropdown is pane-local. The dock
// button path is used because it shares duplicateBox() with the drag path,
// and Playwright cannot synthesize HTML5 drag-and-drop reliably.
//
// Ruling: never type a bare `tmux kill-session` (no `-t`) into a pane that is
// itself attached to the session being killed. tmux resolves an untargeted
// command to the CURRENT session, so killing from inside the pane's own
// client kills that client's own attach — and the pane's WS reconnect then
// re-runs the same `/term?session=...` attach, which is `new-session -A`
// (attach-or-create), recreating the very session just killed. Cleanup below
// always names its target explicitly (`-t '<name>'`) and runs the kill from a
// DIFFERENT pane than the one attached to it (never from inside that pane's
// own terminal).
//
// Undocking (`.pane-undock` → undockBox) does NOT close that watching
// connection — it only PARKS the terminal (main.ts's keep-alive contract:
// the handle moves into the hidden `.stage-parking` div, still connected;
// only `closeTab` sets `closedByUser` and actually closes the WS). So an
// explicit-target kill can still race a live reconnect: the killed session's
// still-parked (or still-docked) client sees its WS drop and, per
// reconnect.ts's escalating backoff (base 1000ms), reattaches after ~1s —
// which is `new-session -A` again — recreating the very session the kill
// just removed. The targeted kill is idempotent (`2>/dev/null`), so each
// cleanup below waits past that base delay and re-issues the SAME kill to
// reap any session a reconnect recreated in the meantime.

async function login(page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function promptIn(pane) {
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
}

// Reads the tmux session a pane is attached to straight off the pane itself
// (`tmux display-message -p '#S'`) rather than assuming it — the fixture box's
// configured session name is a fresh `tmuxifiertest-<8 hex>` minted by
// test/helpers/localBox.js on every suite run (see global-setup.js), and a
// duplicate's derived name carries a `-N` suffix on top of it
// (duplicateSession.ts's `chooseDuplicateSession`).
async function readSessionName(page, pane) {
  await pane.click();
  // `clear;` first: scrollback:0 means the pane's visible screen carries only
  // what's currently ON SCREEN — but tmux itself does not wipe that on
  // reattach, so an EARLIER command this same pane already had echoed back
  // (e.g. another test's own `tmux kill-session -t '<name>-2' ...` cleanup,
  // whose literal command TEXT contains this same pattern) can already
  // satisfy the wait below before the fresh output this call is about to
  // produce ever renders — a race a plain "read whatever matches" cannot
  // resolve, since the stale text really is the only match at that instant.
  // Clearing first removes the stale text from the screen entirely, so the
  // next match can only be the fresh one.
  await page.keyboard.type("clear; tmux display-message -p '#S'");
  await page.keyboard.press('Enter');
  const rows = pane.locator('.xterm-rows');
  await expect(rows).toContainText(/tmuxifiertest-[0-9a-f]{8}/i, { timeout: 10000 });
  const text = await rows.innerText();
  const match = text.match(/tmuxifiertest-[0-9a-f]{8}(?:-\d+)?/i);
  if (!match) throw new Error(`could not read a tmux session name from pane output: ${text}`);
  return match[0];
}

test('duplicating with only one session creates <name>-2; the dropdown stays pane-local', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const firstPane = page.locator('.stage-pane').first();
  await promptIn(firstPane);

  const configured = await readSessionName(page, firstPane);
  await promptIn(firstPane);

  const row = page.locator('.box', { has: page.locator('.name', { hasText: 'localhost' }) });
  await row.locator('.dock').click();
  await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 10000 });

  const secondPane = page.locator('.stage-pane').nth(1);
  await promptIn(secondPane);
  try {
    // The second pane really is attached to the derived session — assert the
    // exact full name, not a bare /-2/ regex.
    const secondSession = await readSessionName(page, secondPane);
    expect(secondSession).toBe(`${configured}-2`);

    // Pane-local: the first pane's dropdown still names the configured
    // session, untouched by the duplicate.
    await expect(firstPane.locator('.session-picker-trigger')).not.toContainText('-2');
  } finally {
    // Undock the duplicate (parks its terminal — the WS stays connected, see
    // the file-level comment), then kill `<configured>-2` by explicit name
    // from the surviving first pane, never from inside the pane that was
    // attached to it. Parking means that kill can still race the parked
    // client's own reconnect-and-recreate, so wait past the ~1s backoff base
    // and re-issue the same (idempotent) kill to reap anything it recreated.
    await secondPane.locator('.pane-undock').click().catch(() => {});
    await firstPane.click().catch(() => {});
    await page.keyboard.type(`tmux kill-session -t '${configured}-2' 2>/dev/null`).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});
    await firstPane.click().catch(() => {});
    await page.keyboard.type(`tmux kill-session -t '${configured}-2' 2>/dev/null`).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});

test('duplicating adopts a live unshown session before creating one', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const firstPane = page.locator('.stage-pane').first();
  await promptIn(firstPane);
  try {
    await firstPane.click();
    await page.keyboard.type('tmux new-session -d -s sparee2e');
    await page.keyboard.press('Enter');
    await promptIn(firstPane);

    const row = page.locator('.box', { has: page.locator('.name', { hasText: 'localhost' }) });
    await row.locator('.dock').click();
    await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 10000 });
    const secondPane = page.locator('.stage-pane').nth(1);
    await promptIn(secondPane);
    await secondPane.click();
    await page.keyboard.type("tmux display-message -p '#S'");
    await page.keyboard.press('Enter');
    await expect(secondPane.locator('.xterm-rows')).toContainText('sparee2e', { timeout: 10000 });
  } finally {
    // Explicit target, from the FIRST pane (never a bare kill typed into the
    // pane attached to sparee2e) — same discipline as above. secondPane stays
    // docked (still attached, WS live) through this whole block, so the kill
    // can race its reconnect-and-recreate exactly as in the first test above;
    // wait past the ~1s backoff base and re-issue the same (idempotent) kill
    // to reap anything it recreated.
    await firstPane.click().catch(() => {});
    await page.keyboard.type('tmux kill-session -t sparee2e 2>/dev/null').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});
    await firstPane.click().catch(() => {});
    await page.keyboard.type('tmux kill-session -t sparee2e 2>/dev/null').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});

// CRITICAL regression guard: a pane-local session switch (the header dropdown,
// pane-only per spec decision 3) closes that pane's own WS and reopens it
// against the picked session via `/term`'s `session` query param, reusing the
// SAME viewer key (client id). On the unfixed sessions.js, `sessions.open()`
// reused that key's live/grace-window entry regardless of which session was
// requested, so the pane silently reattached to the session it was trying to
// LEAVE. This test fails on the unfixed code.
test('pane-local dropdown switch reattaches THIS pane to the picked session, leaving the other pane and its session untouched', async ({ page }) => {
  await login(page);
  await page.locator('.box .name', { hasText: 'localhost' }).click();
  const firstPane = page.locator('.stage-pane').first();
  await promptIn(firstPane);

  const configured = await readSessionName(page, firstPane);
  await promptIn(firstPane);

  const row = page.locator('.box', { has: page.locator('.name', { hasText: 'localhost' }) });
  await row.locator('.dock').click();
  await expect(page.locator('.stage-pane')).toHaveCount(2, { timeout: 10000 });
  const secondPane = page.locator('.stage-pane').nth(1);
  await promptIn(secondPane);

  try {
    // A spare session, created from pane 1 so pane 2's own attach is
    // untouched by the act of creating it.
    await firstPane.click();
    await page.keyboard.type('tmux new-session -d -s swtiche2e');
    await page.keyboard.press('Enter');
    await promptIn(firstPane);

    // Pane 2's own dropdown-switch: pick the spare session from pane 2's
    // picker. Same open/probe idiom as sessionDropdown.spec.ts — reaching for
    // the trigger re-probes the box so the just-created session is there.
    // dockBox above already ran its own freshProbe.refresh for this box
    // (duplicateBox), so let that freshness window (freshProbe.ts, main.ts's
    // freshMs: 3000) lapse first — otherwise this hover answers from that
    // still-fresh probe with no new request, and the wait below times out.
    await page.waitForTimeout(3200);

    const picker = secondPane.locator('.session-picker');
    const trigger = picker.locator('.session-picker-trigger');
    const probed = page.waitForRequest(
      (r) => /\/api\/boxes\/[^/]+\/probe$/.test(r.url()) && r.method() === 'POST',
      { timeout: 10000 },
    );
    await trigger.hover();
    await probed;
    await trigger.click();
    const target = picker.locator('.session-picker-row', { hasText: 'swtiche2e' });
    await expect(target).toHaveCount(1, { timeout: 10000 });
    await target.locator('.session-picker-pick').click();

    // THE regression assertion. Wait for the switch to reconnect, then read
    // pane 2's live tmux session name straight off the pane.
    await promptIn(secondPane);
    await secondPane.click();
    await page.keyboard.type("tmux display-message -p '#S'");
    await page.keyboard.press('Enter');
    await expect(secondPane.locator('.xterm-rows')).toContainText('swtiche2e', { timeout: 10000 });

    // Pane 1 is untouched: still attached to its original configured session.
    const firstAfter = await readSessionName(page, firstPane);
    expect(firstAfter).toBe(configured);
  } finally {
    // Two sessions to reap: `swtiche2e` (created above) and `<configured>-2`
    // — the session duplicateBox itself created for pane 2 at dock time
    // (adopt-then-create finds nothing else live to adopt at that point, same
    // as the first test above), now orphaned (detached, no client) once the
    // picker moved pane 2 off it. Explicit targets, from pane 1 (never from
    // inside pane 2, which is attached to swtiche2e) — same discipline as the
    // tests above. Pane 2 stays docked and attached through this whole block,
    // so the kill can race its reconnect-and-recreate; wait past the ~1s
    // backoff base and re-issue the same (idempotent) kills to reap anything
    // recreated.
    await firstPane.click().catch(() => {});
    await page.keyboard.type("tmux kill-session -t 'swtiche2e' 2>/dev/null").catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.keyboard.type(`tmux kill-session -t '${configured}-2' 2>/dev/null`).catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});
    await firstPane.click().catch(() => {});
    await page.keyboard.type("tmux kill-session -t 'swtiche2e' 2>/dev/null").catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});
