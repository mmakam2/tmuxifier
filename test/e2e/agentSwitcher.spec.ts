import { test, expect, type Page, type Locator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The agent switcher end to end (agentSwitcher.ts + its main.ts wiring): hold
// Ctrl+Shift, tap K to step through every agent session in the fleet, release
// a modifier to land on the highlighted one.
//
// Fixture facts that shape every assertion (see agentStates.spec.ts):
//  - The three seeded boxes (localhost, db-primary, untagged-worker) are ssh
//    aliases of ONE tmux server, so every fixture session is a row under each
//    box. Rows are targeted by data-box + data-session, never by index/count.
//  - The e2e Host Shell reads this host's REAL tmux, so a Host Shell row may be
//    in the list. No test may ever commit to a row it did not pick: a test that
//    releases onto "whatever is highlighted" first seeds the MRU so the
//    highlight is a fixture row, and the rest end on Escape / blur / logout.
//  - The client's health series arrives at boot and then every 30 s (plus the
//    /live nudges), so arrival is forced with reloads (rowsReady).
//  - A pane made to look like Claude: `exec -a claude sleep` reads as `claude`
//    in pane_current_command; markers are written straight into the fixture home.

const cfg = process.env.E2E_SSH_CONFIG!;
const host = process.env.E2E_BOX_HOST!;
const home = process.env.E2E_BOX_HOME!;
const configured = process.env.E2E_BOX_SESSION!;
const markerDir = path.join(home, '.tmuxifier-agent');
const A = 'sw-a';
const B = 'sw-b';
const OCC = 'sw-occ';

function onBox(cmd: string): string {
  return execFileSync('ssh', ['-F', cfg, host, cmd], { encoding: 'utf8' });
}
// Temp file + rename, as the hook does: the watch must never read half a marker.
function writeMarker(name: string, state: string, epoch: number, cause: string) {
  fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(markerDir, `${name}.tmp`), `${name}:${state}:${epoch}:${cause}\n`, { mode: 0o600 });
  fs.renameSync(path.join(markerDir, `${name}.tmp`), path.join(markerDir, name));
}
const now = () => Math.floor(Date.now() / 1000);

// `sleep 600` can run out over a long run; a test that finds a session gone
// brings it back (its marker is still in place).
function ensureAgentSessions() {
  for (const [s, tag] of [[A, 'A'], [B, 'B']]) {
    onBox(`tmux has-session -t '=${s}' 2>/dev/null || tmux new-session -d -s '${s}' bash -c 'echo SWPREVIEW_${tag}; exec -a claude sleep 600'`);
  }
}

test.beforeAll(() => {
  for (const s of [A, B]) { try { onBox(`tmux kill-session -t '=${s}'`); } catch { /* none */ } }
  ensureAgentSessions();
  expect(onBox(`tmux display-message -p -t '=${A}:' '#{pane_current_command}'`).trim()).toBe('claude');
  expect(onBox(`tmux display-message -p -t '=${B}:' '#{pane_current_command}'`).trim()).toBe('claude');
  writeMarker(A, 'working', now() - 60, 'prompt');
  writeMarker(B, 'blocked', now(), 'permission');
});

test.beforeEach(() => { ensureAgentSessions(); });

test.afterAll(() => {
  for (const s of [A, B]) {
    try { fs.rmSync(path.join(markerDir, s), { force: true }); } catch { /* gone */ }
    try { onBox(`tmux kill-session -t '=${s}'`); } catch { /* gone */ }
  }
});

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

const boxRow = (page: Page, label: string) =>
  page.locator('.box', { has: page.locator('.name', { hasText: new RegExp(`^${label}$`) }) }).first();

// Reload until both alias boxes the tests hop between report both fixture
// sessions: the switcher's rows are built from the same series as the badge.
async function rowsReady(page: Page) {
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
    for (const label of ['localhost', 'db-primary']) {
      const badge = boxRow(page, label).locator('.badge[class*="badge-agent-"]');
      await expect(badge).toHaveAttribute('title', new RegExp(`${A}: (working|blocked)`), { timeout: 4000 });
      await expect(badge).toHaveAttribute('title', new RegExp(`${B}: blocked`), { timeout: 1000 });
    }
  }).toPass({ timeout: 45000 });
}

async function fresh(page: Page) {
  await login(page);
  await page.evaluate(() => {
    localStorage.removeItem('tmuxifier.agentMru');
    localStorage.removeItem('tmuxifier.stageLayout');
  });
  await rowsReady(page);
}

async function boxIdOf(page: Page, label: string): Promise<string> {
  const id = await page.evaluate(async (l) => {
    const boxes: { id: string; label: string }[] = await (await fetch('/api/boxes')).json();
    return boxes.find((b) => b.label === l)?.id ?? null;
  }, label);
  expect(id, `box ${label}`).toBeTruthy();
  return id!;
}

const paneOf = (page: Page, label: string): Locator =>
  page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: new RegExp(`^${label}$`) }) });

// The trigger shows the active WINDOW's label once the snapshot lists the
// session's windows; the picker's current row names the session itself
// (`s:<session>`, or `w:<session>:@id`), so that is what is read.
async function expectOnSession(pane: Locator, session: string) {
  await expect(pane.locator('.session-picker .session-picker-row.current'))
    .toHaveAttribute('data-key', new RegExp(`^[ws]:${session}(:|$)`), { timeout: 15000 });
}

async function dock(page: Page, label: string): Promise<Locator> {
  await page.locator('.box .name', { hasText: new RegExp(`^${label}$`) }).click();
  const pane = paneOf(page, label);
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  return pane;
}

async function dockBeside(page: Page, label: string): Promise<Locator> {
  const before = await page.locator('.stage-pane').count();
  await page.getByRole('button', { name: `Dock beside current terminal — ${label}` }).click();
  await expect(page.locator('.stage-pane')).toHaveCount(before + 1);
  const pane = paneOf(page, label);
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  return pane;
}

const selected = (page: Page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.agent-switcher-row')];
  const i = rows.findIndex((r) => r.getAttribute('aria-selected') === 'true');
  const r = rows[i];
  return { index: i, count: rows.length, key: r ? `${r.getAttribute('data-box')}\n${r.getAttribute('data-session')}` : null };
});

const holdMods = async (page: Page) => { await page.keyboard.down('Control'); await page.keyboard.down('Shift'); };
const releaseMods = async (page: Page) => { await page.keyboard.up('Shift'); await page.keyboard.up('Control'); };

// Hold the chord and tap K until the highlight is on (boxId, session), then
// release onto it. A miss cancels with Escape first, so a failing test never
// lands on a row nobody picked.
async function chordTo(page: Page, boxId: string, session: string) {
  await holdMods(page);
  let hit = false;
  try {
    for (let i = 0; i < 12 && !hit; i++) {
      await page.keyboard.press('KeyK');
      hit = (await selected(page)).key === `${boxId}\n${session}`;
      if (!hit) await page.waitForTimeout(30);
    }
    if (!hit) await page.keyboard.press('Escape');
  } finally {
    await releaseMods(page);
  }
  expect(hit, `no switcher row for ${boxId} / ${session}`).toBe(true);
}

// A quick tap: open and release before the 150 ms paint.
async function tap(page: Page) {
  await holdMods(page);
  await page.keyboard.press('KeyK');
  await releaseMods(page);
}

// Every input frame (`t: 'i'`) sent on a /term socket, and each socket's close.
function termFrames(page: Page) {
  const out = { input: [] as { t: string; d: string }[], sockets: [] as { url: string; closed: boolean }[] };
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/term?')) return;
    const rec = { url: ws.url(), closed: false };
    out.sockets.push(rec);
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload));
        if (m?.t === 'i') out.input.push(m);
      } catch { /* not JSON */ }
    });
    ws.on('close', () => { rec.closed = true; });
  });
  return out;
}

// Whether #agent-switcher was EVER attached since this call — read off the
// mutation records, so a mount and unmount within one task still counts.
async function watchAttach(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __swAttached: boolean };
    w.__swAttached = false;
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if ((n as Element).id === 'agent-switcher') w.__swAttached = true;
    }).observe(document.body, { childList: true });
  });
}
const everAttached = (page: Page) => page.evaluate(() => (window as unknown as { __swAttached: boolean }).__swAttached);

const clients = (session: string): number => {
  try {
    return onBox(`tmux list-clients -t '=${session}' -F x`).split('\n').filter(Boolean).length;
  } catch {
    return -1;
  }
};

test('the chord opens, steps, and releases onto the highlighted session, replacing the focused pane', async ({ page }) => {
  await fresh(page);
  const db = await boxIdOf(page, 'db-primary');
  await dock(page, 'localhost');
  await chordTo(page, db, A);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  const pane = page.locator('.stage-pane');
  await expect(pane.locator('.pane-title')).toHaveText('db-primary');
  await expectOnSession(pane, A);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
});

test('the pane it replaces is released: its socket closes and tmux drops the client at once', async ({ page }) => {
  test.setTimeout(90000);
  const frames = termFrames(page);
  try {
    onBox(`tmux kill-session -t '=${OCC}' 2>/dev/null; tmux new-session -d -s '${OCC}'`);
    await fresh(page);
    const loc = await boxIdOf(page, 'localhost');
    const db = await boxIdOf(page, 'db-primary');
    const pane = await dock(page, 'localhost');

    // Point the pane at a session no other test uses, so its client count is
    // this pane's alone (earlier tests leave grace-window clients elsewhere).
    const picker = pane.locator('.session-picker');
    await picker.locator('.session-picker-trigger').click();
    const row = picker.locator('.session-picker-row', { hasText: OCC }).first();
    await expect(row).toHaveCount(1, { timeout: 10000 });
    await row.locator('.session-picker-pick').click();
    await expectOnSession(pane, OCC);
    await expect.poll(() => clients(OCC), { timeout: 15000 }).toBe(1);
    // onBox is synchronous and blocks the event loop, so Playwright's socket
    // events are read through a poll, never straight after a box command.
    const isOcc = (u: string) => u.includes(`box=${encodeURIComponent(loc)}`) && u.includes(`session=${OCC}`);
    await expect.poll(() => frames.sockets.filter((s) => !s.closed && isOcc(s.url)).length).toBe(1);
    const occ = frames.sockets.find((s) => !s.closed && isOcc(s.url))!;

    await chordTo(page, db, A);
    await expect(page.locator('.stage-pane .pane-title')).toHaveText('db-primary');
    await expect.poll(() => occ!.closed).toBe(true);
    // The grace window is 45 s; the release close drops the PTY at once.
    await expect.poll(() => clients(OCC), { timeout: 5000 }).toBe(0);
  } finally {
    try { onBox(`tmux kill-session -t '=${OCC}'`); } catch { /* gone */ }
  }
});

test('a session already open in another pane just gets focus', async ({ page }) => {
  const frames = termFrames(page);
  await fresh(page);
  const db = await boxIdOf(page, 'db-primary');
  const locPane = await dock(page, 'localhost');
  const dbPane = await dockBeside(page, 'db-primary');
  await chordTo(page, db, A); // db-primary is focused: it switches in place
  await expectOnSession(dbPane, A);
  await expect(dbPane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
  await locPane.click();
  await expect(locPane).toHaveClass(/focused/);
  const sockets = frames.sockets.length;

  await chordTo(page, db, A);
  await expect(dbPane).toHaveClass(/focused/);
  await expect(locPane).not.toHaveClass(/focused/);
  await expect(page.locator('.stage-pane')).toHaveCount(2);
  await expectOnSession(dbPane, A);
  await page.waitForTimeout(1000); // give a would-be reattach every chance to show up
  expect(frames.sockets.length).toBe(sockets);
});

test('same box, another session: the focused pane switches session in place', async ({ page }) => {
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  await dock(page, 'localhost');
  await chordTo(page, loc, B);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  const pane = paneOf(page, 'localhost');
  await expectOnSession(pane, B);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_B', { timeout: 15000 });
});

test('a quick tap flips to the previous session and back', async ({ page }) => {
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  const pane = await dock(page, 'localhost');
  await chordTo(page, loc, A);
  await expectOnSession(pane, A);
  await chordTo(page, loc, B);
  await expectOnSession(pane, B);

  await tap(page);
  await expectOnSession(pane, A);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
  await tap(page);
  await expectOnSession(pane, B);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_B', { timeout: 15000 });
  await expect(page.locator('.stage-pane')).toHaveCount(1);
});

test('holding the chord key scrolls the list', async ({ page }) => {
  await fresh(page);
  await dock(page, 'localhost');
  await holdMods(page);
  try {
    await page.keyboard.down('KeyK');
    let last = (await selected(page)).index;
    expect(last).toBeGreaterThanOrEqual(0);
    let changes = 0;
    // Playwright does not auto-repeat: a down() on a held key sends the
    // repeat: true keydown an OS auto-repeat would.
    const until = Date.now() + 700;
    while (Date.now() < until) {
      await page.waitForTimeout(50);
      await page.keyboard.down('KeyK');
      const i = (await selected(page)).index;
      if (i !== last) { changes++; last = i; }
    }
    expect(changes).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Escape');
    await page.keyboard.up('KeyK');
  } finally {
    await releaseMods(page);
  }
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expect(paneOf(page, 'localhost')).toHaveCount(1);
});

test('ArrowDown and ArrowUp step while open, and wrap', async ({ page }) => {
  await fresh(page);
  await holdMods(page); // standby: nothing focused, so no pinned row
  try {
    await page.keyboard.press('KeyK');
    const first = await selected(page);
    expect(first.index).toBe(0);
    expect(first.count).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('ArrowUp');
    expect((await selected(page)).index).toBe(first.count - 1);
    await page.keyboard.press('ArrowDown');
    expect((await selected(page)).index).toBe(0);
    await page.keyboard.press('ArrowDown');
    expect((await selected(page)).index).toBe(1);
    await page.keyboard.press('ArrowUp');
    expect((await selected(page)).index).toBe(0);
    await page.keyboard.press('Escape');
  } finally {
    await releaseMods(page);
  }
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expect(page.locator('.stage-pane')).toHaveCount(0);
});

test('Esc cancels: nothing moves and the overlay is gone', async ({ page }) => {
  const frames = termFrames(page);
  await fresh(page);
  const pane = await dock(page, 'localhost');
  await expectOnSession(pane, configured);
  const sockets = frames.sockets.length;
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
  } finally {
    await releaseMods(page);
  }
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expect(paneOf(page, 'localhost')).toHaveCount(1);
  await expectOnSession(pane, configured);
  await page.waitForTimeout(1000); // give a would-be commit every chance to reattach
  expect(frames.sockets.length).toBe(sockets);
});

test('nothing docked: the session opens as the first pane', async ({ page }) => {
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  await expect(page.locator('.stage-pane')).toHaveCount(0);
  await chordTo(page, loc, A);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  const pane = paneOf(page, 'localhost');
  await expect(pane).toHaveCount(1);
  await expectOnSession(pane, A);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
});

test('a parked tab on another session is not reused under the new header', async ({ page }) => {
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  await dock(page, 'localhost'); // on the configured session
  await page.click('#home'); // parks it, still connected
  await expect(page.locator('.stage-pane')).toHaveCount(0);
  await chordTo(page, loc, A);
  const pane = paneOf(page, 'localhost');
  await expect(pane).toHaveCount(1);
  await expectOnSession(pane, A);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
});

test('no chord key reaches the PTY, and plain Ctrl+K still does', async ({ page }) => {
  test.setTimeout(90000);
  const frames = termFrames(page);
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  const db = await boxIdOf(page, 'db-primary');
  // Two panes on two agent sessions, so every release below lands on a pane
  // that is already open (a focus move, no new attach).
  const locPane = await dock(page, 'localhost');
  await chordTo(page, loc, A);
  await expect(locPane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
  const dbPane = await dockBeside(page, 'db-primary');
  await chordTo(page, db, B);
  await expect(dbPane.locator('.xterm-rows')).toContainText('SWPREVIEW_B', { timeout: 15000 });
  await locPane.click();
  await expect(locPane).toHaveClass(/focused/);
  const sockets = frames.sockets.length;
  frames.input.length = 0; // the attach handshakes above are not chord keys

  // A tap: the most recent other session is db-primary's.
  await tap(page);
  await expect(dbPane).toHaveClass(/focused/);

  // A held K (with its auto-repeats), stepped back with the arrows.
  await holdMods(page);
  await page.keyboard.down('KeyK');
  for (let i = 0; i < 8; i++) await page.keyboard.down('KeyK');
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.up('KeyK');
  await releaseMods(page);
  await expect(locPane).toHaveClass(/focused/);

  // ArrowDown / ArrowUp.
  await holdMods(page);
  await page.keyboard.press('KeyK');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await releaseMods(page);
  await expect(dbPane).toHaveClass(/focused/);

  // Escape.
  await holdMods(page);
  await page.keyboard.press('KeyK');
  await page.keyboard.press('Escape');
  await releaseMods(page);
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expect(dbPane).toHaveClass(/focused/);

  // Control released first while K stays down (and repeats) for 400 ms.
  await holdMods(page);
  await page.keyboard.down('KeyK');
  await page.keyboard.up('Control');
  const until = Date.now() + 400;
  while (Date.now() < until) {
    await page.waitForTimeout(50);
    await page.keyboard.down('KeyK');
  }
  await page.keyboard.up('KeyK');
  await page.keyboard.up('Shift');
  await expect(locPane).toHaveClass(/focused/);

  expect(frames.sockets.length).toBe(sockets);
  expect(frames.input).toEqual([]);
  await page.keyboard.press('Control+KeyK');
  await expect.poll(() => frames.input).toContainEqual(expect.objectContaining({ d: '\u000b' }));
});

test('while the switcher is open the arrows do not move pane focus; closed, Ctrl+Shift+Arrow still does', async ({ page }) => {
  await fresh(page);
  const locPane = await dock(page, 'localhost');
  const dbPane = await dockBeside(page, 'db-primary');
  await locPane.click();
  await expect(locPane).toHaveClass(/focused/);

  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
  } finally {
    await releaseMods(page);
  }
  await expect(locPane).toHaveClass(/focused/);
  await expect(dbPane).not.toHaveClass(/focused/);

  await page.keyboard.press('Control+Shift+ArrowRight');
  await expect(dbPane).toHaveClass(/focused/);
  await expect(locPane).not.toHaveClass(/focused/);
});

test('the hotkey is inert while a modal is open', async ({ page }) => {
  await fresh(page);
  await page.click('#settings');
  await expect(page.locator('.modal-backdrop')).toHaveCount(1);
  await watchAttach(page);
  await tap(page);
  await holdMods(page);
  await page.keyboard.down('KeyK');
  await page.keyboard.up('KeyK');
  await releaseMods(page);
  expect(await everAttached(page)).toBe(false);
  await expect(page.locator('#agent-switcher')).toHaveCount(0);

  // The same chord with the modal closed does open it: the check above is not vacuous.
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toHaveCount(1);
    await page.keyboard.press('Escape');
  } finally {
    await releaseMods(page);
  }
});

test('opening the switcher closes an open session picker', async ({ page }) => {
  await fresh(page);
  const pane = await dock(page, 'localhost');
  const picker = pane.locator('.session-picker');
  await picker.locator('.session-picker-trigger').click();
  await expect(picker.locator('.session-picker-pop')).toBeVisible();
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toHaveCount(1);
    await expect(picker.locator('.session-picker-pop')).toBeHidden();
    await page.keyboard.press('Escape');
  } finally {
    await releaseMods(page);
  }
});

test('clicking a row commits to it', async ({ page }) => {
  await fresh(page);
  const db = await boxIdOf(page, 'db-primary');
  await dock(page, 'localhost');
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toBeVisible();
    await page.locator(`.agent-switcher-row[data-box="${db}"][data-session="${A}"]`).click();
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
  } finally {
    await releaseMods(page);
  }
  const pane = page.locator('.stage-pane');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.pane-title')).toHaveText('db-primary');
  await expectOnSession(pane, A);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
});

// The overlay exists only while Ctrl+Shift is held, so every row click is a
// Ctrl+click — which macOS browsers turn into `contextmenu`, with no `click`.
test('a secondary click on a row commits to it (Ctrl+click on macOS)', async ({ page }) => {
  await fresh(page);
  const db = await boxIdOf(page, 'db-primary');
  await dock(page, 'localhost');
  await page.evaluate(() => {
    const w = window as unknown as { __cm: boolean[] };
    w.__cm = [];
    window.addEventListener('contextmenu', (ev) => { w.__cm.push(ev.defaultPrevented); });
  });
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toBeVisible();
    expect((await selected(page)).key).not.toBe(`${db}\n${A}`);
    // Anywhere else inside the overlay, the native menu is refused too.
    const notCancelled = await page.evaluate(() => document.querySelector('.agent-switcher-preview')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(notCancelled).toBe(false);
    await page.locator(`.agent-switcher-row[data-box="${db}"][data-session="${A}"]`).click({ button: 'right' });
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
  } finally {
    await releaseMods(page);
  }
  expect(await page.evaluate(() => (window as unknown as { __cm: boolean[] }).__cm)).toEqual([true, true]);
  const pane = page.locator('.stage-pane');
  await expect(pane).toHaveCount(1);
  await expect(pane.locator('.pane-title')).toHaveText('db-primary');
  await expectOnSession(pane, A);
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
});

// The overlay root is a backdrop: a click outside the panel cancels and never
// reaches the app underneath (a Ctrl+Shift+click on the gear opening Settings
// under the switcher; on macOS a missed Ctrl+click raising the native menu,
// which eats the modifiers' keyups and leaves the overlay stuck open).
// Each test seeds the MRU so a release that wrongly commits lands on sw-b, a
// fixture row, never on the real Host Shell.
async function seedOnA(page: Page): Promise<Locator> {
  const loc = await boxIdOf(page, 'localhost');
  const pane = await dock(page, 'localhost');
  await chordTo(page, loc, B);
  await expectOnSession(pane, B);
  await chordTo(page, loc, A);
  await expectOnSession(pane, A);
  // The A socket is up (callers count sockets from here on).
  await expect(pane.locator('.xterm-rows')).toContainText('SWPREVIEW_A', { timeout: 15000 });
  return pane;
}

test('clicking outside the panel cancels and does not reach the app underneath', async ({ page }) => {
  const frames = termFrames(page);
  await fresh(page);
  const pane = await seedOnA(page);
  const gear = (await page.locator('#settings').boundingBox())!;
  const sockets = frames.sockets.length;
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toBeVisible();
    await page.waitForTimeout(200); // past the 150 ms paint
    await page.mouse.click(gear.x + gear.width / 2, gear.y + gear.height / 2);
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
  } finally {
    await releaseMods(page);
  }
  await expect(page.locator('.settings-modal')).toHaveCount(0);
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expectOnSession(pane, A);
  await page.waitForTimeout(1000); // give a would-be commit every chance to reattach
  expect(frames.sockets.length).toBe(sockets);
});

test('a secondary click outside the panel is refused and cancels', async ({ page }) => {
  const frames = termFrames(page);
  await fresh(page);
  const pane = await seedOnA(page);
  const gear = (await page.locator('#settings').boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __cm: boolean[] };
    w.__cm = [];
    window.addEventListener('contextmenu', (ev) => { w.__cm.push(ev.defaultPrevented); });
  });
  const sockets = frames.sockets.length;
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toBeVisible();
    await page.waitForTimeout(200);
    await page.mouse.click(gear.x + gear.width / 2, gear.y + gear.height / 2, { button: 'right' });
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
  } finally {
    await releaseMods(page);
  }
  expect(await page.evaluate(() => (window as unknown as { __cm: boolean[] }).__cm)).toEqual([true]);
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expect(page.locator('.settings-modal')).toHaveCount(0);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expectOnSession(pane, A);
  await page.waitForTimeout(1000);
  expect(frames.sockets.length).toBe(sockets);
});

// `.pending` (visibility: hidden, no pointer events) must be on the root from
// the moment it is attached, so the quick-tap window never blocks a click.
test('the overlay starts hidden', async ({ page }) => {
  await fresh(page);
  await page.evaluate(() => {
    const w = window as unknown as { __swClass: string[] | null };
    w.__swClass = null;
    new MutationObserver((recs) => {
      for (const r of recs) {
        for (const n of r.addedNodes) {
          if ((n as Element).id === 'agent-switcher' && w.__swClass === null) w.__swClass = [...(n as Element).classList];
        }
      }
    }).observe(document.body, { childList: true });
  });
  await holdMods(page);
  try {
    await page.keyboard.down('KeyK');
    await expect(page.locator('#agent-switcher')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.up('KeyK');
  } finally {
    await releaseMods(page);
  }
  expect(await page.evaluate(() => (window as unknown as { __swClass: string[] | null }).__swClass)).toContain('pending');
});

test('the order is frozen while open and a state change repaints the chip in place', async ({ page }) => {
  test.setTimeout(90000);
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  const keys = () => page.evaluate(() => [...document.querySelectorAll('.agent-switcher-row')].map((r) => `${r.getAttribute('data-box')}\n${r.getAttribute('data-session')}`));
  const row = page.locator(`.agent-switcher-row[data-box="${loc}"][data-session="${A}"]`);
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(row.locator('.agent-switcher-chip')).toHaveText('working');
    await expect(row.locator('.agent-switcher-chip')).toHaveClass(/chip-agent-working/);
    const before = await keys();
    writeMarker(A, 'blocked', now(), 'permission');
    // blocked sorts ahead of working, so a rebuilt list would move this row.
    await expect(row.locator('.agent-switcher-chip')).toHaveText('blocked · permission', { timeout: 40000 });
    await expect(row.locator('.agent-switcher-chip')).toHaveClass(/chip-agent-blocked/);
    expect(await keys()).toEqual(before);
    await page.keyboard.press('Escape');
  } finally {
    await releaseMods(page);
    writeMarker(A, 'working', now() - 60, 'prompt');
  }
});

test('MRU survives a reload', async ({ page }) => {
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  const db = await boxIdOf(page, 'db-primary');
  const locPane = await dock(page, 'localhost');
  await chordTo(page, loc, A);
  await expectOnSession(locPane, A);
  await chordTo(page, db, B);
  const dbPane = paneOf(page, 'db-primary');
  await expectOnSession(dbPane, B);

  // Without the stored MRU the tap would land on a blocked sw-b row (the
  // board's precedence), not on localhost's sw-a.
  await rowsReady(page);
  await expectOnSession(dbPane, B);
  await tap(page);
  const pane = paneOf(page, 'localhost');
  await expect(pane).toHaveCount(1);
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expectOnSession(pane, A);
});

test('window blur cancels', async ({ page }) => {
  const frames = termFrames(page);
  await fresh(page);
  const pane = await dock(page, 'localhost');
  const sockets = frames.sockets.length;
  await holdMods(page);
  try {
    await page.keyboard.press('KeyK');
    await expect(page.locator('#agent-switcher')).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
  } finally {
    await releaseMods(page);
  }
  await expect(page.locator('.stage-pane')).toHaveCount(1);
  await expectOnSession(pane, configured);
  await page.waitForTimeout(1000); // give a would-be commit every chance to reattach
  expect(frames.sockets.length).toBe(sockets);
});

test('logout tears the overlay down', async ({ page }) => {
  await fresh(page);
  await holdMods(page);
  try {
    await page.keyboard.down('KeyK');
    await expect(page.locator('#agent-switcher')).toBeVisible();
    await page.evaluate(() => (document.querySelector('#logout') as HTMLElement).click());
    await expect(page.locator('#pw')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
    await page.keyboard.up('KeyK');
  } finally {
    await releaseMods(page);
  }
  // On the login screen the chord opens nothing.
  await watchAttach(page);
  await tap(page);
  expect(await everAttached(page)).toBe(false);
});

test('held past 150 ms the overlay is visible; after a quick tap nothing is left behind', async ({ page }) => {
  await fresh(page);
  const loc = await boxIdOf(page, 'localhost');
  const pane = await dock(page, 'localhost');
  // Seed the MRU so the tap below lands on a fixture row.
  await chordTo(page, loc, B);
  await expectOnSession(pane, B);
  await chordTo(page, loc, A);
  await expectOnSession(pane, A);

  await holdMods(page);
  try {
    await page.keyboard.down('KeyK');
    await expect(page.locator('#agent-switcher')).toHaveCount(1);
    await expect(page.locator('#agent-switcher')).toBeVisible();
    await page.waitForTimeout(250); // still held at 400 ms
    await expect(page.locator('#agent-switcher')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.up('KeyK');
  } finally {
    await releaseMods(page);
  }
  await expect(page.locator('#agent-switcher')).toHaveCount(0);

  await tap(page);
  await expect(page.locator('#agent-switcher')).toHaveCount(0);
  await expectOnSession(pane, B);
});

// The preview (agentSwitcherPreview.ts scheduler, painted by agentSwitcher.ts):
// the highlighted session's last screen lines as plain text, fetched only once
// the highlight rests 250 ms, cached 5 s per open of the overlay.
test.describe('preview', () => {
  const M = 'sw-m';
  const scriptM = path.join(home, 'sw-m.sh');

  // Every pane capture this page asks for (the box route and the Host Shell's).
  function paneRequests(page: Page): string[] {
    const out: string[] = [];
    page.on('request', (req) => { if (/\/pane\?/.test(req.url())) out.push(req.url()); });
    return out;
  }
  function seenPosts(page: Page): string[] {
    const out: string[] = [];
    page.on('request', (req) => { if (req.method() === 'POST' && req.url().includes('/agent-seen')) out.push(req.url()); });
    return out;
  }
  // Box-route captures of one (box, session); unrelated requests are ignored.
  const capturesOf = (reqs: string[], boxId: string, session: string) => reqs.filter((u) => {
    const url = new URL(u);
    return url.pathname === `/api/boxes/${encodeURIComponent(boxId)}/pane` && url.searchParams.get('session') === session;
  });

  const body = (page: Page) => page.locator('#agent-switcher .agent-switcher-preview-body');
  const head = (page: Page) => page.locator('#agent-switcher .agent-switcher-preview-head');

  // With the chord held: step until the highlight is on (boxId, session),
  // tapping fast enough (well under the 250 ms rest) that nothing in between
  // is fetched.
  async function stepTo(page: Page, boxId: string, session: string) {
    for (let i = 0; i < 24; i++) {
      if ((await selected(page)).key === `${boxId}\n${session}`) return;
      await page.keyboard.press('KeyK');
    }
    expect((await selected(page)).key, `no switcher row for ${boxId} / ${session}`).toBe(`${boxId}\n${session}`);
  }

  test('tapping through rows fetches nothing; resting fetches once and shows the screen', async ({ page }) => {
    const reqs = paneRequests(page);
    await fresh(page);
    const loc = await boxIdOf(page, 'localhost');
    await holdMods(page);
    try {
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('KeyK');
        await page.waitForTimeout(60);
      }
      expect(reqs).toEqual([]);
      await stepTo(page, loc, A);
      await expect(body(page)).toContainText('SWPREVIEW_A', { timeout: 15000 });
      await expect(body(page)).toHaveAttribute('data-view', 'text');
      await expect(head(page)).toContainText('localhost');
      await expect(head(page)).toContainText(A);
      await expect(head(page).locator('.agent-switcher-chip')).toHaveClass(/chip-agent-working/);
      await page.waitForTimeout(600); // a second request would have shown by now
      expect(capturesOf(reqs, loc, A)).toHaveLength(1);
      await page.keyboard.press('Escape');
    } finally {
      await releaseMods(page);
    }
  });

  test('the request names the session and 40 lines and never sizes anything', async ({ page }) => {
    const reqs = paneRequests(page);
    await fresh(page);
    const loc = await boxIdOf(page, 'localhost');
    await holdMods(page);
    try {
      await page.keyboard.press('KeyK');
      await stepTo(page, loc, A);
      await expect.poll(() => capturesOf(reqs, loc, A).length, { timeout: 5000 }).toBe(1);
      const q = new URL(capturesOf(reqs, loc, A)[0]).searchParams;
      expect(q.get('session')).toBe(A);
      expect(q.get('lines')).toBe('40');
      expect(q.has('cols')).toBe(false);
      expect(q.has('rows')).toBe(false);
      expect(q.has('client')).toBe(false);
      await page.keyboard.press('Escape');
    } finally {
      await releaseMods(page);
    }
  });

  test('the preview is text, not markup, with escapes stripped', async ({ page }) => {
    test.setTimeout(90000);
    try {
      fs.writeFileSync(scriptM, "printf '<b>bold</b> \\033[31mred\\033[0m\\n'\nexec -a claude sleep 600\n", { mode: 0o700 });
      onBox(`tmux kill-session -t '=${M}' 2>/dev/null; tmux new-session -d -s '${M}' 'bash ${scriptM}'`);
      await expect.poll(() => onBox(`tmux display-message -p -t '=${M}:' '#{pane_current_command}'`).trim()).toBe('claude');
      writeMarker(M, 'working', now() - 30, 'prompt');
      await login(page);
      const loc = await boxIdOf(page, 'localhost');
      await expect(async () => {
        await page.reload();
        await expect(boxRow(page, 'localhost').locator('.badge[class*="badge-agent-"]'))
          .toHaveAttribute('title', new RegExp(`${M}: working`), { timeout: 4000 });
      }).toPass({ timeout: 45000 });
      await holdMods(page);
      try {
        await page.keyboard.press('KeyK');
        await stepTo(page, loc, M);
        await expect(body(page)).toContainText('<b>bold</b> red', { timeout: 15000 });
        expect(await body(page).evaluate((el) => el.querySelector('b'))).toBeNull();
        expect(await body(page).evaluate((el) => el.textContent)).not.toContain('\x1b');
        await page.keyboard.press('Escape');
      } finally {
        await releaseMods(page);
      }
    } finally {
      try { fs.rmSync(path.join(markerDir, M), { force: true }); } catch { /* gone */ }
      try { onBox(`tmux kill-session -t '=${M}'`); } catch { /* gone */ }
      try { fs.rmSync(scriptM, { force: true }); } catch { /* gone */ }
    }
  });

  test('highlighting and previewing a done session never marks it seen', async ({ page }) => {
    test.setTimeout(90000);
    const seen = seenPosts(page);
    const reqs = paneRequests(page);
    const badgeReadsDone = async () => {
      await expect(async () => {
        await page.reload();
        await expect(boxRow(page, 'localhost').locator('.badge[class*="badge-agent-"]'))
          .toHaveAttribute('title', new RegExp(`${A}: done`), { timeout: 4000 });
      }).toPass({ timeout: 45000 });
    };
    try {
      writeMarker(A, 'ready', now(), 'stop'); // ready/stop = done until seen
      await login(page);
      const loc = await boxIdOf(page, 'localhost');
      await page.evaluate(() => localStorage.removeItem('tmuxifier.stageLayout'));
      await badgeReadsDone();
      const pane = await dock(page, 'localhost'); // on the configured session, not sw-a
      await expectOnSession(pane, configured);
      await holdMods(page);
      try {
        await page.keyboard.press('KeyK');
        await stepTo(page, loc, A);
        await expect(body(page)).toContainText('SWPREVIEW_A', { timeout: 15000 });
        await expect(head(page).locator('.agent-switcher-chip')).toHaveClass(/chip-agent-done/);
        await page.waitForTimeout(1500);
        await page.keyboard.press('Escape');
      } finally {
        await releaseMods(page);
      }
      expect(capturesOf(reqs, loc, A)).toHaveLength(1); // the preview did happen
      await page.waitForTimeout(1000);
      expect(seen).toEqual([]);
      await expect(boxRow(page, 'localhost').locator('.badge[class*="badge-agent-"]'))
        .toHaveAttribute('title', new RegExp(`${A}: done`));
      await badgeReadsDone(); // the server agrees: still done after a reload
      expect(seen).toEqual([]);
    } finally {
      writeMarker(A, 'working', now() - 60, 'prompt');
    }
  });

  test('coming back to a row inside 5 s reuses the snapshot', async ({ page }) => {
    const reqs = paneRequests(page);
    await fresh(page);
    const loc = await boxIdOf(page, 'localhost');
    await holdMods(page);
    try {
      await page.keyboard.press('KeyK');
      await stepTo(page, loc, A);
      await expect(body(page)).toContainText('SWPREVIEW_A', { timeout: 15000 });
      await stepTo(page, loc, B);
      await expect(body(page)).toContainText('SWPREVIEW_B', { timeout: 15000 });
      await stepTo(page, loc, A);
      await expect(body(page)).toContainText('SWPREVIEW_A', { timeout: 1000 });
      await page.waitForTimeout(600); // a refetch would have shown by now
      expect(capturesOf(reqs, loc, A)).toHaveLength(1);
      expect(capturesOf(reqs, loc, B)).toHaveLength(1);
      expect([...capturesOf(reqs, loc, A), ...capturesOf(reqs, loc, B)]).toHaveLength(2);
      await page.keyboard.press('Escape');
    } finally {
      await releaseMods(page);
    }
  });

  test('a failed capture shows one line and the switcher still commits', async ({ page }) => {
    await fresh(page);
    const db = await boxIdOf(page, 'db-primary');
    await dock(page, 'localhost');
    await page.route((u) => u.pathname.endsWith('/pane'), (r) => r.fulfill({ status: 502, json: { error: 'boom' } }));
    await holdMods(page);
    try {
      await page.keyboard.press('KeyK');
      await stepTo(page, db, A);
      await expect(body(page)).toHaveText('Preview unavailable', { timeout: 15000 });
      await expect(body(page)).toHaveAttribute('data-view', 'error');
    } finally {
      await releaseMods(page);
    }
    await expect(page.locator('#agent-switcher')).toHaveCount(0);
    const pane = page.locator('.stage-pane');
    await expect(pane).toHaveCount(1);
    await expect(pane.locator('.pane-title')).toHaveText('db-primary');
    await expectOnSession(pane, A);
  });

  test('a quick tap never fetches a preview', async ({ page }) => {
    const reqs = paneRequests(page);
    await fresh(page);
    const loc = await boxIdOf(page, 'localhost');
    const pane = await dock(page, 'localhost');
    // Seed the MRU so the tap lands on a fixture row.
    await chordTo(page, loc, B);
    await expectOnSession(pane, B);
    await chordTo(page, loc, A);
    await expectOnSession(pane, A);
    reqs.length = 0;
    await tap(page);
    await expectOnSession(pane, B);
    await page.waitForTimeout(600); // past the 250 ms rest
    expect(reqs).toEqual([]);
  });
});
