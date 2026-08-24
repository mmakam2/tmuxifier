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
// always names its target explicitly (`-t '<name>'`) and, for the pane the
// test itself created, runs the kill from a DIFFERENT pane after the
// duplicate has been undocked (so nothing is left watching/reconnecting to
// it) rather than from the duplicate's own terminal.

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
  await page.keyboard.type("tmux display-message -p '#S'");
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
    // Undock the duplicate FIRST — this drops its PTY/WS so nothing is left
    // watching `<configured>-2` — then kill that session by explicit name
    // from the surviving first pane, never from inside the pane that was
    // attached to it.
    await secondPane.locator('.pane-undock').click().catch(() => {});
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
    // pane attached to sparee2e) — same discipline as above.
    await firstPane.click().catch(() => {});
    await page.keyboard.type('tmux kill-session -t sparee2e 2>/dev/null').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
  }
});
