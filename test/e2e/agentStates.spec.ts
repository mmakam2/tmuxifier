import { test, expect, type Page, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentPanes, resetAgentPanes, writePaneMarker, type AgentPaneLayout } from './agentPaneBox';

// The four-state agent model end to end: hook marker files on the box →
// server probe → health series → every client surface (sidebar agent rows,
// attention strip, standby agents board, pane-header chip, session picker
// chip) → the seen acknowledgement that turns `done` into `idle`.
//
// The box is the isolated sshd fixture (test/helpers/localBox.js). A pane is
// made to look like Claude Code without installing it: tmux's
// pane_current_command is argv[0]'s basename, so `exec -a claude sleep 600`
// reads as `claude` to the probe. Markers are written straight into the
// fixture home, in the exact format claudeAgentHooks.js's hook writes.
//
// Two fixture facts shape the assertions:
//  - All three seeded boxes (localhost, db-primary, untagged-worker) are ssh
//    aliases of the SAME fixture and tmux server, so every marker is seen by
//    all three: the strip counts 3 panes per marker, and per-box
//    assertions are scoped to the localhost row / card.
//  - The client reads /api/status and /api/health/series on a 30 s interval
//    (main.ts POLL_MS; the server's own 2 s poll only freshens the cache).
//    State ARRIVAL is therefore forced with reloads (boot polls at once);
//    the checks that are about live polling (seen ack exactly once, focus
//    surviving a repaint, done → idle without a reload) wait on observed
//    /api/health/series responses instead, never on fixed sleeps.
//  - The e2e server runs on the operator's host, and its Host Shell sampler
//    (localAgent.js) reads the host's REAL tmux server and ~/.tmuxifier-agent.
//    The strip counts Host Shell panes too, so whatever the operator's own
//    Claude is doing right now is in the totals. stripReads() adds the Host
//    Shell's per-state row count (read in the same DOM pass as the strip) to
//    the fixture's expected count.

const cfg = process.env.E2E_SSH_CONFIG!;
const host = process.env.E2E_BOX_HOST!;
const home = process.env.E2E_BOX_HOME!;
const session = process.env.E2E_BOX_SESSION!;
const session2 = `${session}-a2`;
const markerDir = path.join(home, '.tmuxifier-agent');

function onBox(cmd: string): string {
  return execFileSync('ssh', ['-F', cfg, host, cmd], { encoding: 'utf8' });
}

function writeMarker(name: string, state: string, epoch: number, cause: string) {
  fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(markerDir, name), `${name}:${state}:${epoch}:${cause}\n`, { mode: 0o600 });
}

const now = () => Math.floor(Date.now() / 1000);

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

// The strip segment's text next to the text it should have: `boxPanes`
// fixture panes plus however many Host Shell agent rows are in `state`, both
// read in one evaluate, so they always come from the same repaint.
async function stripReads(page: Page, state: string, boxPanes: number): Promise<string> {
  return page.evaluate(([st, n0]) => {
    const seg = document.querySelector(`#agent-strip .agent-strip-seg[data-state="${st}"]`);
    const local = document.querySelectorAll(`li.box-agents[data-agents-for="__local__"] .box-agent[data-state="${st}"]`).length;
    const n = (n0 as number) + local;
    const want = n === 0 ? null : st === 'blocked' ? `${n} need${n === 1 ? 's' : ''} you` : `${n} ${st}`;
    const got = seg ? seg.textContent : null;
    return got === want ? 'ok' : `strip ${st}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
  }, [state, boxPanes] as const);
}

// Reload until `check` passes: the boot poll reads the server's current cache,
// which the 2 s server poll keeps fresh.
async function reloadUntil(page: Page, check: () => Promise<void>, timeout = 30000) {
  await expect(async () => {
    await page.reload();
    await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
    await check();
  }).toPass({ timeout });
}

test('agent states reach rows, strip, board, chips; a seen done turns idle', async ({ page }) => {
  test.setTimeout(300000);

  // Count the client's health polls so the live-poll checks can wait on
  // "N more polls happened" rather than on wall-clock time.
  let healthPolls = 0;
  page.on('response', (r) => { if (/\/api\/health\/series(\?|$)/.test(r.url())) healthPolls++; });
  const morePolls = async (n: number) => {
    const target = healthPolls + n;
    await expect.poll(() => healthPolls, { timeout: 35000 * n, intervals: [500] }).toBeGreaterThanOrEqual(target);
  };

  // Every seen ack the page sends, with the ts it carried.
  const seenPosts: { pane: string; ts: number }[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'POST' && /\/agent-seen$/.test(r.url())) seenPosts.push(r.postDataJSON());
  });

  try {
    // The fixture session may not exist yet when this spec runs first (panes
    // create it on attach); make sure it does, then put a fake claude in it.
    onBox(`tmux has-session -t '=${session}' 2>/dev/null || tmux new-session -d -s '${session}'`);
    onBox(`tmux respawn-pane -k -t '=${session}:' bash -c 'exec -a claude sleep 600'`);
    onBox(`tmux new-session -d -s '${session2}' bash -c 'exec -a claude sleep 600'`);
    expect(onBox(`tmux display-message -p -t '=${session}:' '#{pane_current_command}'`).trim()).toBe('claude');
    expect(onBox(`tmux display-message -p -t '=${session2}:' '#{pane_current_command}'`).trim()).toBe('claude');
    const pane1 = onBox(`tmux display-message -p -t '=${session}:' '#{pane_id}'`).trim();
    const pane2 = onBox(`tmux display-message -p -t '=${session2}:' '#{pane_id}'`).trim();

    const t0 = now();
    writeMarker(session, 'blocked', t0, 'permission');
    writeMarker(session2, 'ready', t0, 'stop'); // ready/stop = done until seen

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    expect(boxId).toBeTruthy();
    const agentRow = (pane: string) => page.locator(`li.box-agents[data-agents-for="${boxId}"] .box-agent[data-pane="${pane}"]`);

    // ── Sidebar rows: one per agent pane, each with its own state chip. A
    // session-wide marker speaks for the agent pane of its session.
    await reloadUntil(page, async () => {
      await expect(agentRow(pane1)).toHaveAttribute('data-state', 'blocked', { timeout: 5000 });
    });
    await expect(agentRow(pane1).locator('.badge-agent-blocked')).toHaveText('blocked · permission');
    await expect(agentRow(pane2)).toHaveAttribute('data-state', 'done');

    // ── Attention strip: sessions counted across all three alias boxes.
    const strip = page.locator('#agent-strip');
    const seg = (st: string) => strip.locator(`.agent-strip-seg[data-state="${st}"]`);
    await expect(strip).toBeVisible();
    await expect.poll(() => stripReads(page, 'blocked', 3)).toBe('ok');
    await expect.poll(() => stripReads(page, 'done', 3)).toBe('ok');

    // ── Strip filter semantics: ANY session in the state keeps the box. A
    // worst-state filter would hide localhost under `done` (its worst is
    // blocked); the any-session rule keeps it.
    const rowVisible = () => expect(page.locator('#boxes .box .name', { hasText: /^localhost$/ })).toBeVisible();
    await seg('done').click();
    await expect(seg('done')).toHaveAttribute('aria-pressed', 'true');
    await rowVisible();
    await expect(page.locator('#boxes .box')).toHaveCount(3);
    await seg('done').click(); // clicking the active segment clears
    await expect(seg('done')).toHaveAttribute('aria-pressed', 'false');
    await seg('blocked').click();
    await expect(seg('blocked')).toHaveAttribute('aria-pressed', 'true');
    await rowVisible();
    await seg('blocked').click();
    await expect(seg('blocked')).toHaveAttribute('aria-pressed', 'false');
    await expect(strip.locator('.agent-strip-seg[aria-pressed="true"]')).toHaveCount(0);

    // ── A filter expands a collapsed group: collapse Prod, filter, and the
    // Prod rows show; clearing the filter restores the collapse.
    const prod = page.locator('#boxes .box-group', { has: page.locator('.group-name', { hasText: /^Prod$/ }) });
    await prod.locator('.group-header').click();
    await expect(prod).toHaveClass(/collapsed/);
    await expect(prod.locator('.box .name', { hasText: /^localhost$/ })).toBeHidden();
    await seg('blocked').click();
    await expect(prod).not.toHaveClass(/collapsed/);
    await expect(prod.locator('.box .name', { hasText: /^localhost$/ })).toBeVisible();
    await seg('blocked').click();
    await expect(prod).toHaveClass(/collapsed/);
    await prod.locator('.group-header').click(); // leave it expanded again
    await expect(prod).not.toHaveClass(/collapsed/);

    // ── Standby dashboard board (no pane docked): one card per agent pane, in
    // its state's column, named as its sidebar row is. The fixture panes sit in
    // two sessions, so the name carries its session. Cards are found by pane id
    // AND box: the Host Shell's own cards (a different tmux server) can reuse a
    // pane id, and nothing here may touch them.
    const card = page.locator(`.dash-board .dash-board-col[data-state="blocked"] .dash-card[data-box-id="${boxId}"][data-pane="${pane1}"]`);
    await expect(card.locator('.dash-card-cause')).toHaveText('permission');
    await expect(card.locator('.dash-card-box')).toHaveText('localhost');
    await expect(card.locator('.dash-card-session')).toHaveText((await agentRow(pane1).locator('.box-agent-name').textContent())!);
    await expect(card.locator('.dash-card-session')).toContainText(`${session} › `);
    await expect(card.locator('.dash-card-age')).not.toBeEmpty();
    await expect(page.locator(`.dash-board .dash-board-col[data-state="done"] .dash-card[data-box-id="${boxId}"][data-pane="${pane2}"]`)).toHaveCount(1);
    await expect(page.locator(`.dash-board .dash-card[data-pane="${pane1}"]:not([data-box-id="__local__"])`)).toHaveCount(3); // the three alias boxes

    // ── Clicking the card docks that box on its pane's session; the pane chip.
    await card.click();
    const pane = page.locator('.stage-pane').first();
    await expect(pane).toBeVisible();
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-blocked')).toHaveText('blocked · permission', { timeout: 15000 });
    await expect(page.locator('.dash-board')).toHaveCount(0); // standby gone once docked

    // ── Session picker: each session row carries its own chip.
    const picker = pane.locator('.session-picker');
    await picker.locator('.session-picker-trigger').click();
    const row2 = picker.locator('.session-picker-pick', { hasText: session2 });
    await expect(row2.locator('.session-picker-chip.chip-agent-done')).toHaveText('done', { timeout: 10000 });
    const row1 = picker.locator('.session-picker-pick', { hasText: new RegExp(`^${session}(?!-a2)`) }).first();
    await expect(row1.locator('.session-picker-chip.chip-agent-blocked')).toHaveText('blocked · permission');
    // The session's only window holds that agent, so its window row says the same.
    await expect(picker.locator(`.session-picker-row[data-key^="w:${session}:"] .session-picker-chip.chip-agent-blocked`))
      .toHaveText('blocked · permission');
    await page.keyboard.press('Escape');
    await expect(picker.locator('.session-picker-pop')).toBeHidden();

    // The seen ack needs a focused document.
    await page.bringToFront();
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);

    // ── Seen ack exactly once per marker ts, across several polls. The first
    // ack is answered by the test, not the server, so the session STAYS done
    // and later polls get every chance to (wrongly) send it again.
    await page.route('**/agent-seen', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));
    const t1 = t0 + 1;
    writeMarker(session, 'ready', t1, 'stop');
    // Live poll, no reload: proves the chip follows the series on its own and
    // keeps this page's once-per-ts memory intact.
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-done')).toHaveText('done', { timeout: 45000 });
    await expect.poll(() => seenPosts.filter((p) => p.ts === t1).length, { timeout: 10000 }).toBe(1);
    expect(seenPosts.filter((p) => p.ts === t1)[0]).toEqual({ pane: pane1, ts: t1 });

    // ── Keyboard focus survives a repaint: rides the same polls.
    await seg('done').focus();
    await morePolls(2);
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-done')).toHaveText('done'); // still unacked server-side
    expect(seenPosts.filter((p) => p.ts === t1).length).toBe(1);
    expect(seenPosts.filter((p) => p.pane === pane2)).toEqual([]); // not docked → never acked
    expect(await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return a?.classList.contains('agent-strip-seg') ? a.dataset.state : null;
    })).toBe('done');

    // ── No ack while the page is hidden.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const t2 = t0 + 2;
    writeMarker(session, 'ready', t2, 'stop');
    // No surface renders the ts, so wait on polls: the first may race the
    // marker write, the second (~30 s later, server polling every 2 s)
    // certainly carries t2 — and the POST below, carrying t2, confirms the
    // client had it. No POST for it may go out while hidden.
    await morePolls(2);
    expect(seenPosts.filter((p) => p.ts === t2)).toEqual([]);

    // ── Visible again: the visibilitychange ack goes to the real server, which
    // flips done → idle; the next live poll shows it.
    await page.unroute('**/agent-seen');
    const acked = page.waitForResponse((r) => /\/agent-seen$/.test(r.url()) && r.request().method() === 'POST');
    await page.evaluate(() => {
      delete (document as any).visibilityState; // back to Document.prototype's getter
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const res = await acked;
    expect(res.status()).toBe(200);
    expect(res.request().postDataJSON()).toEqual({ pane: pane1, ts: t2 });
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-idle')).toHaveText('idle', { timeout: 45000 });
    expect(seenPosts.filter((p) => p.ts === t2).length).toBe(1);
    // Only localhost acknowledged; its two aliases still read done.
    // localhost: session2's pane still done, the acked pane idle — both count.
    await expect(agentRow(pane2)).toHaveAttribute('data-state', 'done');
    await expect(agentRow(pane1)).toHaveAttribute('data-state', 'idle');
    await expect.poll(() => stripReads(page, 'idle', 1)).toBe('ok');
    await expect.poll(() => stripReads(page, 'done', 5)).toBe('ok');
  } finally {
    try { fs.rmSync(path.join(markerDir, session), { force: true }); } catch { /* gone */ }
    try { fs.rmSync(path.join(markerDir, session2), { force: true }); } catch { /* gone */ }
    try { onBox(`tmux kill-session -t '=${session2}'`); } catch { /* gone */ }
    // Back to a login shell, as a fresh session starts. A bare respawn-pane
    // would re-run the pane's LAST command — the fake claude set above.
    try { onBox(`tmux respawn-pane -k -t '=${session}:' "$(tmux show-options -gv default-shell)" -l`); } catch { /* no session */ }
  }
});

// The pane is the unit (spec 2026-11-26 §7.1, §4.5, §7.3): one sidebar row per
// agent pane under its box, named for its window (`.paneIndex` only where a
// window holds two agents), no box badge; the strip counts panes; looking at a
// window acknowledges only the agents in it; a row click jumps to its pane.
test('sidebar: one row per agent pane, per-pane seen, and a row click jumps to the pane', async ({ page }) => {
  test.setTimeout(240000);
  let layout: AgentPaneLayout | null = null;
  const seenPosts: { pane: string; ts: number }[] = [];
  const windowPosts: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => {
    if (r.method() !== 'POST') return;
    if (/\/agent-seen$/.test(r.url())) seenPosts.push(r.postDataJSON());
    if (/\/api\/boxes\/[^/]+\/window$/.test(r.url())) windowPosts.push(r.postDataJSON());
  });
  let healthPolls = 0;
  page.on('response', (r) => { if (/\/api\/health\/series(\?|$)/.test(r.url())) healthPolls++; });
  const morePolls = async (n: number) => {
    const target = healthPolls + n;
    await expect.poll(() => healthPolls, { timeout: 35000 * n, intervals: [500] }).toBeGreaterThanOrEqual(target);
  };
  try {
    layout = buildAgentPanes(session);
    const { one, twoA, twoB } = layout;
    const t0 = now();
    writePaneMarker(session, one.pane, 'ready', t0, 'stop'); // ready/stop = done until seen
    writePaneMarker(session, twoA.pane, 'blocked', t0, 'permission');
    writePaneMarker(session, twoB.pane, 'ready', t0 + 1, 'stop');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    const group = page.locator(`li.box-agents[data-agents-for="${boxId}"]`);
    const rows = group.locator('button.box-agent');
    const agentRow = (pane: string) => group.locator(`button.box-agent[data-pane="${pane}"]`);

    // ── 1. Three rows directly under the box, named and ordered by window and
    // pane, each with its own chip; nothing agent-shaped left in the badges.
    await reloadUntil(page, async () => { await expect(rows).toHaveCount(3, { timeout: 5000 }); });
    await expect(rows.locator('.box-agent-name')).toHaveText([one.name, twoA.name, twoB.name]);
    expect(await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.pane))).toEqual([one.pane, twoA.pane, twoB.pane]);
    expect(await row.evaluate((li) => {
      const next = li.nextElementSibling as HTMLElement | null;
      return next?.classList.contains('box-agents') ? next.dataset.agentsFor : null;
    })).toBe(boxId);
    await expect(agentRow(one.pane)).toHaveAttribute('data-state', 'done');
    await expect(agentRow(twoA.pane)).toHaveAttribute('data-state', 'blocked');
    await expect(agentRow(twoA.pane).locator('.badge.badge-agent-blocked')).toHaveText('blocked · permission');
    await expect(agentRow(twoB.pane).locator('.badge.badge-agent-done')).toHaveText('done');
    await expect(row.locator('.box-badges [class*="badge-agent-"]')).toHaveCount(0);

    // ── 2. The strip counts panes (all three alias boxes see this tmux), and a
    // segment filter keeps the box and its rows.
    const seg = (st: string) => page.locator(`#agent-strip .agent-strip-seg[data-state="${st}"]`);
    await expect.poll(() => stripReads(page, 'blocked', 3)).toBe('ok');
    await expect.poll(() => stripReads(page, 'done', 6)).toBe('ok');
    await seg('blocked').click();
    await expect(seg('blocked')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#boxes .box .name', { hasText: /^localhost$/ })).toBeVisible();
    await expect(rows).toHaveCount(3);
    await seg('blocked').click();
    await expect(seg('blocked')).toHaveAttribute('aria-pressed', 'false');

    // ── 3. Dock the box on window 1: its done is acknowledged once, with the
    // pane, and the row turns idle; window 2's done is never acknowledged.
    await page.bringToFront();
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);
    await page.locator('.box .name', { hasText: /^localhost$/ }).click();
    const pane = page.locator('.stage-pane').first();
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_ONE', { timeout: 15000 });
    await expect.poll(() => seenPosts.filter((p) => p.pane === one.pane).length, { timeout: 15000 }).toBe(1);
    expect(seenPosts.filter((p) => p.pane === one.pane)).toEqual([{ pane: one.pane, ts: t0 }]);
    await expect(agentRow(one.pane)).toHaveAttribute('data-state', 'idle', { timeout: 45000 });
    await morePolls(1);
    expect(seenPosts.filter((p) => p.pane === one.pane)).toHaveLength(1);
    expect(seenPosts.filter((p) => p.pane === twoB.pane || p.pane === twoA.pane)).toEqual([]);
    await expect(agentRow(twoB.pane)).toHaveAttribute('data-state', 'done');

    // ── 4. A row click jumps: the window route gets session, window and pane;
    // the terminal shows window 2; its done is then acknowledged.
    await agentRow(twoB.pane).click();
    await expect.poll(() => windowPosts.length, { timeout: 10000 }).toBe(1);
    expect(windowPosts[0]).toEqual({ session, windowId: twoB.windowId, paneId: twoB.pane });
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_TWO_B', { timeout: 15000 });
    await expect(pane.locator('.xterm-rows')).not.toContainText('AGENT_WINDOW_ONE');
    expect(onBox(`tmux display-message -p -t '=${session}:' '#{window_id} #{pane_id}'`).trim()).toBe(`${twoB.windowId} ${twoB.pane}`);
    await expect.poll(() => seenPosts.filter((p) => p.pane === twoB.pane).length, { timeout: 45000 }).toBe(1);
    expect(seenPosts.filter((p) => p.pane === twoB.pane)).toEqual([{ pane: twoB.pane, ts: t0 + 1 }]);
    await expect(agentRow(twoB.pane)).toHaveAttribute('data-state', 'idle', { timeout: 45000 });
    expect(seenPosts.filter((p) => p.pane === twoA.pane)).toEqual([]); // blocked is not done
  } finally {
    resetAgentPanes(layout, session);
  }
});

// What the sidebar-row tests below share: the fixture, the requests the page
// sends, and a wait on the page's own health reads (a fleet-wide poll or a
// nudged single-box read), never on wall-clock time. None of them touches a
// Host Shell row: the e2e server's Host Shell is this machine's real `local`
// session, and a jump there would move the operator's own windows.
async function rowsFixture(page: Page, states: [one: string, twoA: string, twoB: string]) {
  const layout = buildAgentPanes(session);
  const t0 = now();
  // ready/stop reads `done` until seen.
  const marker = (pane: string, st: string) => {
    const [state, cause] = st === 'done' ? ['ready', 'stop'] : st === 'blocked' ? ['blocked', 'permission'] : ['working', 'prompt'];
    writePaneMarker(session, pane, state, t0, cause);
  };
  marker(layout.one.pane, states[0]);
  marker(layout.twoA.pane, states[1]);
  marker(layout.twoB.pane, states[2]);
  const seenPosts: { pane: string; ts: number }[] = [];
  const windowPosts: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => {
    if (r.method() !== 'POST') return;
    if (/\/agent-seen$/.test(r.url())) seenPosts.push(r.postDataJSON());
    if (/\/api\/boxes\/[^/]+\/window$/.test(r.url())) windowPosts.push(r.postDataJSON());
  });
  let healthReads = 0;
  page.on('response', (r) => { if (/\/api\/health\/series(\?|$)/.test(r.url())) healthReads++; });
  const moreReads = async (n: number) => {
    const target = healthReads + n;
    await expect.poll(() => healthReads, { timeout: 35000 * n, intervals: [500] }).toBeGreaterThanOrEqual(target);
  };
  await login(page);
  const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
  const boxId = (await row.getAttribute('data-id'))!;
  const group = page.locator(`li.box-agents[data-agents-for="${boxId}"]`);
  const agentRow = (pane: string) => group.locator(`button.box-agent[data-pane="${pane}"]`);
  await reloadUntil(page, async () => {
    await expect(group.locator('button.box-agent')).toHaveCount(3, { timeout: 5000 });
    await expect(agentRow(layout.twoB.pane)).toHaveAttribute('data-state', states[2], { timeout: 5000 });
  });
  return { layout, t0, seenPosts, windowPosts, moreReads, agentRow };
}

// Spec 2026-11-26 §7.3 step 3: docking the box repaints the stage while the
// series in hand still shows the window the jump is LEAVING; nothing of the box
// may be acknowledged until fresh data shows the target window in front. And
// once it does, looking at a window clears every agent visible in it: both
// split panes of the window the jump lands in are `done` and both are acked.
test('a jump into an undocked box acknowledges every done agent of the window it lands in, and none of the window it leaves', async ({ page }) => {
  test.setTimeout(240000);
  let layout: AgentPaneLayout | null = null;
  try {
    const f = await rowsFixture(page, ['done', 'done', 'done']);
    layout = f.layout;
    const { one, twoA, twoB } = f.layout;
    await expect(f.agentRow(one.pane)).toHaveAttribute('data-state', 'done');
    await expect(page.locator('.stage-pane')).toHaveCount(0); // not docked
    await page.bringToFront();
    expect(await page.evaluate(() => document.hasFocus())).toBe(true);

    await f.agentRow(twoB.pane).click();
    await expect.poll(() => f.windowPosts.length, { timeout: 10000 }).toBe(1);
    const pane = page.locator('.stage-pane').first();
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_TWO_B', { timeout: 15000 });
    await expect.poll(() => f.seenPosts.filter((p) => p.pane === twoB.pane).length, { timeout: 45000 }).toBe(1);
    await expect.poll(() => f.seenPosts.filter((p) => p.pane === twoA.pane).length, { timeout: 10000 }).toBe(1);
    await f.moreReads(1);
    // Each split pane of the landing window, once, with its own marker ts.
    expect(f.seenPosts.filter((p) => p.pane === twoB.pane)).toEqual([{ pane: twoB.pane, ts: f.t0 }]);
    expect(f.seenPosts.filter((p) => p.pane === twoA.pane)).toEqual([{ pane: twoA.pane, ts: f.t0 }]);
    expect(f.seenPosts.filter((p) => p.pane === one.pane)).toEqual([]);
    await expect(f.agentRow(one.pane)).toHaveAttribute('data-state', 'done');
    await expect(f.agentRow(twoB.pane)).toHaveAttribute('data-state', 'idle', { timeout: 45000 });
    await expect(f.agentRow(twoA.pane)).toHaveAttribute('data-state', 'idle', { timeout: 45000 });
  } finally {
    resetAgentPanes(layout, session);
  }
});

// Rows repaint in place: a health read, even one that changes the focused
// row's own state, keeps the very same button node and its keyboard focus.
test('a focused agent row survives health reads, its own state change included', async ({ page }) => {
  test.setTimeout(240000);
  let layout: AgentPaneLayout | null = null;
  try {
    const f = await rowsFixture(page, ['working', 'working', 'working']);
    layout = f.layout;
    const { twoA } = f.layout;
    await f.agentRow(twoA.pane).focus();
    await f.agentRow(twoA.pane).evaluate((el) => { (el as unknown as { __e2eTag: string }).__e2eTag = 'kept'; });
    const stillIt = () => page.evaluate((pane) => {
      const a = document.activeElement as (HTMLElement & { __e2eTag?: string }) | null;
      return a?.dataset.pane === pane && a.__e2eTag === 'kept' && a.isConnected;
    }, twoA.pane);
    await f.moreReads(1);
    expect(await stillIt()).toBe(true);
    writePaneMarker(session, twoA.pane, 'blocked', f.t0 + 1, 'question');
    await expect(f.agentRow(twoA.pane)).toHaveAttribute('data-state', 'blocked', { timeout: 45000 });
    await expect(f.agentRow(twoA.pane).locator('.badge-agent-blocked')).toHaveText('blocked · question');
    expect(await stillIt()).toBe(true);
    await f.moreReads(1);
    expect(await stillIt()).toBe(true);
  } finally {
    resetAgentPanes(layout, session);
  }
});

// A select the box refuses (409 while setup runs) is reported, moves nothing
// and acknowledges nothing; a row whose pane is already focused sends no select.
test('a refused jump is reported and changes nothing; a focused pane\'s row sends no select', async ({ page }) => {
  test.setTimeout(240000);
  let layout: AgentPaneLayout | null = null;
  try {
    const f = await rowsFixture(page, ['working', 'working', 'done']);
    layout = f.layout;
    const { one, twoB } = f.layout;
    await page.bringToFront();
    await page.locator('.box .name', { hasText: /^localhost$/ }).click();
    const pane = page.locator('.stage-pane').first();
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_ONE', { timeout: 15000 });
    const where = () => onBox(`tmux display-message -p -t '=${session}:' '#{window_id} #{pane_id}'`).trim();
    expect(where()).toBe(`${one.windowId} ${one.pane}`);

    await page.route('**/api/boxes/*/window', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"box is being set up"}' }));
    await f.agentRow(twoB.pane).click();
    await expect.poll(() => f.windowPosts.length, { timeout: 10000 }).toBe(1);
    await expect(page.locator('.toast.toast-error')).toHaveText('box is being set up');
    await f.moreReads(1);
    await expect(page.locator('.stage-pane')).toHaveCount(1);
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_ONE');
    await expect(pane.locator('.xterm-rows')).not.toContainText('AGENT_WINDOW_TWO_B');
    expect(where()).toBe(`${one.windowId} ${one.pane}`);
    expect(f.seenPosts.filter((p) => p.pane === twoB.pane)).toEqual([]);
    await expect(f.agentRow(twoB.pane)).toHaveAttribute('data-state', 'done');
    await page.unroute('**/api/boxes/*/window');

    // Window 1's only pane is tmux's focused one: its row docks and sends no select.
    await expect(f.agentRow(one.pane)).toHaveAttribute('data-state', 'working');
    await f.agentRow(one.pane).click();
    await f.moreReads(1);
    expect(f.windowPosts).toHaveLength(1);
    expect(where()).toBe(`${one.windowId} ${one.pane}`);
  } finally {
    resetAgentPanes(layout, session);
  }
});

// Spec 2026-11-26 §7.2: the pane header chip is what the terminal shows (the
// worst state among the agents on screen in its session), while the picker is
// the per-window summary: each window row the worst of its panes, the session
// row the worst of the session.
test('header chip is the visible window\'s worst; picker rows carry each window\'s and the session\'s worst', async ({ page }) => {
  test.setTimeout(240000);
  let layout: AgentPaneLayout | null = null;
  const windowPosts: Record<string, unknown>[] = [];
  const seenPosts: unknown[] = [];
  page.on('request', (r: Request) => {
    if (r.method() !== 'POST') return;
    if (/\/api\/boxes\/[^/]+\/window$/.test(r.url())) windowPosts.push(r.postDataJSON());
    if (/\/agent-seen$/.test(r.url())) seenPosts.push(r.postDataJSON());
  });
  try {
    layout = buildAgentPanes(session);
    const { one, twoA, twoB } = layout;
    const t0 = now();
    // Window 1 (in front): one working agent. Window 2: a working and a blocked
    // one, so its worst is not simply its first pane's. Nothing is `done`, which
    // a focused client would acknowledge on sight.
    writePaneMarker(session, one.pane, 'working', t0, 'prompt');
    writePaneMarker(session, twoA.pane, 'working', t0, 'prompt');
    writePaneMarker(session, twoB.pane, 'blocked', t0, 'question');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    const agentRows = page.locator(`li.box-agents[data-agents-for="${boxId}"] button.box-agent`);
    // The data is in before the box is docked, so the chip below has a worse
    // agent in the other window to (wrongly) pick up.
    await reloadUntil(page, async () => {
      await expect(agentRows).toHaveCount(3, { timeout: 5000 });
      await expect(agentRows.and(page.locator(`[data-pane="${twoB.pane}"]`))).toHaveAttribute('data-state', 'blocked', { timeout: 5000 });
    });

    await page.locator('.box .name', { hasText: /^localhost$/ }).click();
    const pane = page.locator('.stage-pane').first();
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_ONE', { timeout: 15000 });
    const chip = pane.locator('.pane-header .pane-chip');
    const picker = pane.locator('.session-picker');
    const pickerChip = (key: string) => picker.locator(`.session-picker-row[data-key="${key}"] .session-picker-chip`);
    const sessionKey = `s:${session}`;
    const win1 = `w:${session}:${one.windowId}`;
    const win2 = `w:${session}:${twoA.windowId}`;

    // ── 1. Window 1 in front: the chip is window 1's agent, and says nothing of
    // the blocked agent behind it.
    // (toContainText: the working chip also holds the sprite's glyphs.)
    await expect(chip).toContainText('working', { timeout: 15000 });
    await expect(chip).toHaveClass(/chip-agent-working/);
    await expect(chip.locator('.clawd')).toHaveCount(1); // the working sprite
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-blocked')).toHaveCount(0);

    // ── 2. The picker says what every window is doing, in or out of sight.
    await picker.locator('.session-picker-trigger').click();
    await expect(pickerChip(win1)).toHaveText('working', { timeout: 10000 });
    await expect(pickerChip(win1)).toHaveClass(/chip-agent-working/);
    await expect(pickerChip(win2)).toHaveText('blocked · question');
    await expect(pickerChip(win2)).toHaveClass(/chip-agent-blocked/);
    await expect(pickerChip(sessionKey)).toHaveText('blocked · question');
    await expect(pickerChip(sessionKey)).toHaveClass(/chip-agent-blocked/);
    await page.keyboard.press('Escape');
    await expect(picker.locator('.session-picker-pop')).toBeHidden();

    // ── 3. Pick window 2: the chip follows what the terminal now shows, the
    // worst of its two panes.
    await picker.locator('.session-picker-trigger').click();
    await picker.locator(`.session-picker-row[data-key="${win2}"] .session-picker-pick`).click();
    await expect.poll(() => windowPosts.length, { timeout: 10000 }).toBe(1);
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_TWO_A', { timeout: 15000 });
    await expect(pane.locator('.xterm-rows')).not.toContainText('AGENT_WINDOW_ONE');
    await expect(chip).toHaveText('blocked · question', { timeout: 45000 });
    await expect(chip).toHaveClass(/chip-agent-blocked/);
    await expect(chip.locator('.clawd')).toHaveCount(0);

    // ── 4. A window row repaints on its own while the picker is open: window 1's
    // agent finishes behind the visible window. Its row follows, the session row
    // keeps the blocked agent, the header (window 2) is untouched, and a done
    // agent nobody is looking at is not acknowledged.
    await picker.locator('.session-picker-trigger').click();
    await expect(pickerChip(win1)).toHaveText('working', { timeout: 10000 });
    writePaneMarker(session, one.pane, 'ready', t0 + 1, 'stop');
    await expect(pickerChip(win1)).toHaveText('done', { timeout: 45000 });
    await expect(pickerChip(win1)).toHaveClass(/chip-agent-done/);
    await expect(pickerChip(win2)).toHaveText('blocked · question');
    await expect(pickerChip(sessionKey)).toHaveText('blocked · question');
    await expect(chip).toHaveText('blocked · question');
    expect(seenPosts).toEqual([]);
  } finally {
    resetAgentPanes(layout, session);
  }
});

// Spec 2026-11-26 §7.2: the standby board is one card per agent pane (the box,
// then the pane's row name), in its state's column; the fleet card keeps a
// single chip, the worst of the box. A card click is the sidebar row's jump.
// Nothing here touches a Host Shell card: that is this machine's real `local`
// session, and a jump there would move the operator's own windows.
test('board: one card per agent pane, named as its row; a card click jumps to the pane', async ({ page }) => {
  test.setTimeout(240000);
  let layout: AgentPaneLayout | null = null;
  const terms: string[] = [];
  const windowPosts: Record<string, unknown>[] = [];
  page.on('websocket', (ws) => { if (/\/term\?/.test(ws.url())) terms.push(ws.url()); });
  page.on('request', (r: Request) => {
    if (r.method() === 'POST' && /\/api\/boxes\/[^/]+\/window$/.test(r.url())) windowPosts.push(r.postDataJSON());
  });
  try {
    layout = buildAgentPanes(session);
    const { one, twoA, twoB } = layout;
    const t0 = now();
    // One agent per state column but idle. Window 2's blocked pane is the jump's
    // target: window 1 is in front, so the jump has to select a window AND a pane.
    writePaneMarker(session, one.pane, 'ready', t0, 'stop'); // ready/stop = done until seen
    writePaneMarker(session, twoA.pane, 'working', t0, 'prompt');
    writePaneMarker(session, twoB.pane, 'blocked', t0, 'question');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    // Scoped to the box: the Host Shell's cards can reuse a pane id.
    const cards = page.locator(`.dash-board .dash-card[data-box-id="${boxId}"]`);
    const cardIn = (state: string, pane: string) =>
      page.locator(`.dash-board .dash-board-col[data-state="${state}"] .dash-card[data-box-id="${boxId}"][data-pane="${pane}"]`);
    // This pane's own cards, not just three of them: the previous test's agents
    // (other pane ids) can still be in the server's cache for a second or two.
    await reloadUntil(page, async () => {
      await expect(cardIn('done', one.pane)).toHaveCount(1, { timeout: 5000 });
      await expect(cardIn('working', twoA.pane)).toHaveCount(1, { timeout: 1000 });
      await expect(cardIn('blocked', twoB.pane)).toHaveCount(1, { timeout: 1000 });
      await expect(cards).toHaveCount(3, { timeout: 1000 });
    });

    // ── 1. One card per stateful pane, in its state's column, named as its row.
    expect(await cards.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.pane).sort()))
      .toEqual([one.pane, twoA.pane, twoB.pane].sort());
    for (const [state, p] of [['done', one], ['working', twoA], ['blocked', twoB]] as const) {
      const card = cardIn(state, p.pane);
      await expect(card).toHaveCount(1);
      await expect(card).toHaveAttribute('data-state', state);
      await expect(card.locator('.dash-card-box')).toHaveText('localhost');
      await expect(card.locator('.dash-card-session')).toHaveText(p.name);
      await expect(card.locator('.dash-card-age')).not.toBeEmpty();
    }
    await expect(cardIn('blocked', twoB.pane).locator('.dash-card-cause')).toHaveText('question');
    await expect(cardIn('done', one.pane).locator('.dash-card-cause')).toHaveCount(0); // blocked cards only
    await expect(cardIn('working', twoA.pane).locator('.dash-card-cause')).toHaveCount(0);

    // ── 2. The fleet card keeps ONE chip for the box: the worst of its panes.
    const fleetCard = page.locator('.dash-box', { has: page.locator('.dash-box-name', { hasText: /^localhost$/ }) });
    await expect(fleetCard.locator('.dash-chip')).toHaveText('BLOCKED · QUESTION');
    await expect(fleetCard.locator('.dash-chip')).toHaveClass(/dash-chip-blocked/);

    // ── 3. A card click is the row's jump: the window route gets session,
    // window and pane, the terminal shows window 2, and the one attach is the
    // dock's own.
    expect(terms).toEqual([]); // standby: nothing attached yet
    await cardIn('blocked', twoB.pane).click();
    await expect.poll(() => windowPosts.length, { timeout: 10000 }).toBe(1);
    expect(windowPosts[0]).toEqual({ session, windowId: twoB.windowId, paneId: twoB.pane });
    const pane = page.locator('.stage-pane').first();
    await expect(pane.locator('.xterm-rows')).toContainText('AGENT_WINDOW_TWO_B', { timeout: 15000 });
    await expect(pane.locator('.xterm-rows')).not.toContainText('AGENT_WINDOW_ONE');
    await expect(page.locator('.dash-board')).toHaveCount(0); // standby gone once docked
    expect(onBox(`tmux display-message -p -t '=${session}:' '#{window_id} #{pane_id}'`).trim()).toBe(`${twoB.windowId} ${twoB.pane}`);
    await page.waitForTimeout(1500); // every chance for a second attach to show up
    expect(terms).toHaveLength(1);
    expect(windowPosts).toHaveLength(1); // ...and for a duplicate select to land late
  } finally {
    resetAgentPanes(layout, session);
  }
});

// A board card for an agent in a NON-configured session must dock the box
// straight onto that session: one /term attach, carrying `session=`. Building
// the pane on the configured session first and switching after would attach
// there (which can create that session and run its startupCommand) and then
// tear it down.
test('a board card for an agent in another session docks the box on it with a single /term attach', async ({ page }) => {
  test.setTimeout(120000);
  const terms: string[] = [];
  page.on('websocket', (ws) => { if (/\/term\?/.test(ws.url())) terms.push(ws.url()); });
  try {
    onBox(`tmux has-session -t '=${session2}' 2>/dev/null || tmux new-session -d -s '${session2}' bash -c 'exec -a claude sleep 600'`);
    expect(onBox(`tmux display-message -p -t '=${session2}:' '#{pane_current_command}'`).trim()).toBe('claude');
    const pane2 = onBox(`tmux display-message -p -t '=${session2}:' '#{pane_id}'`).trim();
    // blocked, not done: docking a done pane would acknowledge it.
    writeMarker(session2, 'blocked', now(), 'question');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    const card = page.locator(`.dash-board .dash-board-col[data-state="blocked"] .dash-card[data-box-id="${boxId}"][data-pane="${pane2}"]`);
    await reloadUntil(page, async () => { await expect(card).toHaveCount(1, { timeout: 5000 }); });
    expect(terms).toEqual([]); // standby: nothing attached yet

    await card.click();
    const pane = page.locator('.stage-pane').first();
    // The trigger shows the active WINDOW's label; the picker's current row
    // (value `w:<session>:@id`, or `s:<session>` before windows are listed)
    // names the session the pane is on.
    await expect(pane.locator('.session-picker .session-picker-row.current'))
      .toHaveAttribute('data-key', new RegExp(`^[ws]:${session2}(:|$)`), { timeout: 15000 });
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-blocked')).toHaveText('blocked · question', { timeout: 15000 });
    await expect.poll(() => terms.length).toBe(1);
    // Give a would-be switch-after-attach every chance to show up.
    await page.waitForTimeout(1500);
    expect(terms).toHaveLength(1);
    expect(new URL(terms[0]).searchParams.get('session')).toBe(session2);
  } finally {
    try { fs.rmSync(path.join(markerDir, session2), { force: true }); } catch { /* gone */ }
    try { onBox(`tmux kill-session -t '=${session2}'`); } catch { /* gone */ }
  }
});

// Issue #11. A pane parked on session X keeps its terminal attached to X. A
// board card for the same box's agent in session Y re-docks that instance; the
// parked terminal must not come back under a header that says Y, or every
// keystroke goes to a session the header does not show. The steps are the
// issue's own.
test('a board card does not reuse a parked terminal that is attached to another session', async ({ page }) => {
  test.setTimeout(150000);
  const sessionX = `${session}-px`;
  const terms: string[] = [];
  page.on('websocket', (ws) => { if (/\/term\?/.test(ws.url())) terms.push(ws.url()); });
  const paneOf = (label: string) =>
    page.locator('.stage-pane', { has: page.locator('.pane-title', { hasText: new RegExp(`^${label}$`) }) });
  const onSession = (pane: ReturnType<typeof paneOf>, name: string) =>
    expect(pane.locator('.session-picker .session-picker-row.current'))
      .toHaveAttribute('data-key', new RegExp(`^[ws]:${name}(:|$)`), { timeout: 15000 });
  const clients = (name: string): number => {
    try { return onBox(`tmux list-clients -t '=${name}' -F x`).split('\n').filter(Boolean).length; } catch { return -1; }
  };
  try {
    onBox(`tmux has-session -t '=${sessionX}' 2>/dev/null || tmux new-session -d -s '${sessionX}' bash -c 'echo PARKED_X_SCREEN; exec sleep 600'`);
    onBox(`tmux has-session -t '=${session2}' 2>/dev/null || tmux new-session -d -s '${session2}' bash -c 'echo BOARD_Y_SCREEN; exec -a claude sleep 600'`);
    const pane2 = onBox(`tmux display-message -p -t '=${session2}:' '#{pane_id}'`).trim();
    // blocked, not done: docking a done pane would acknowledge it.
    writeMarker(session2, 'blocked', now(), 'question');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    const card = page.locator(`.dash-board .dash-board-col[data-state="blocked"] .dash-card[data-box-id="${boxId}"][data-pane="${pane2}"]`);
    // Reloads happen only here, before anything is docked: a reload later would
    // throw the parked terminal away and with it the case under test.
    await reloadUntil(page, async () => { await expect(card).toHaveCount(1, { timeout: 5000 }); });

    // 1. Dock box A and point its pane at session X.
    await page.locator('.box .name', { hasText: /^localhost$/ }).click();
    const paneA = paneOf('localhost');
    await expect(paneA).toHaveCount(1);
    const picker = paneA.locator('.session-picker');
    await picker.locator('.session-picker-trigger').click();
    const rowX = picker.locator(`.session-picker-row[data-key="s:${sessionX}"], .session-picker-row[data-key^="w:${sessionX}:"]`).first();
    await expect(rowX).toHaveCount(1, { timeout: 10000 });
    await rowX.locator('.session-picker-pick').click();
    await onSession(paneA, sessionX);
    await expect(paneA.locator('.xterm-rows')).toContainText('PARKED_X_SCREEN', { timeout: 15000 });

    // 2. Dock box B in A's place: A's pane is parked, still attached to X.
    await page.locator('.box .name', { hasText: /^db-primary$/ }).click();
    await expect(page.locator('.stage-pane')).toHaveCount(1);
    const paneB = paneOf('db-primary');
    await expect(paneB).toHaveCount(1);

    // 3. Close B's pane: the standby dashboard shows. A lone pane has no
    // undock cap (that is a split's), so the way out is the nameplate.
    await page.click('#home');
    await expect(page.locator('.stage-pane')).toHaveCount(0);
    await expect(card).toHaveCount(1, { timeout: 15000 });
    expect(clients(session2)).toBe(0); // nothing has attached Y yet

    // 4. Click the card of box A's agent in session Y.
    await card.click();
    const pane = paneOf('localhost');
    await expect(pane).toHaveCount(1);
    await onSession(pane, session2); // what the header says
    // What the terminal is: Y's screen, a /term attach naming Y, a tmux client on Y.
    await expect(pane.locator('.xterm-rows')).toContainText('BOARD_Y_SCREEN', { timeout: 15000 });
    await expect(pane.locator('.xterm-rows')).not.toContainText('PARKED_X_SCREEN');
    expect(new URL(terms[terms.length - 1]).searchParams.get('session')).toBe(session2);
    await expect.poll(() => clients(session2), { timeout: 10000 }).toBe(1);
  } finally {
    try { fs.rmSync(path.join(markerDir, session2), { force: true }); } catch { /* gone */ }
    for (const s of [session2, sessionX]) { try { onBox(`tmux kill-session -t '=${s}'`); } catch { /* gone */ } }
  }
});

// #21 + #22: the engaged strip segment is unmistakable (inverted: a solid
// fill in its own state color under a chassis-dark legend), and the search
// field's ✕ is the one key that resets the whole box list — search term AND
// agent filter — shown whenever either is active.
test('an engaged strip filter reads inverted, and the search ✕ clears it too', async ({ page }) => {
  test.setTimeout(120000);
  try {
    onBox(`tmux has-session -t '=${session}' 2>/dev/null || tmux new-session -d -s '${session}'`);
    onBox(`tmux respawn-pane -k -t '=${session}:' bash -c 'exec -a claude sleep 600'`);
    writeMarker(session, 'blocked', now(), 'permission');

    await login(page);
    const seg = page.locator('#agent-strip .agent-strip-seg[data-state="blocked"]');
    await reloadUntil(page, async () => { await expect(seg).toBeVisible({ timeout: 5000 }); });
    const clear = page.locator('#search-clear');
    const pressed = page.locator('#agent-strip .agent-strip-seg[aria-pressed="true"]');
    const rows = page.locator('#boxes .box');
    const allRows = await rows.count();

    // ── Engaged = inverted: the fill is the segment's own (opaque) text color
    // from rest, and the legend is no longer that color.
    const look = () => seg.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, fg: cs.color };
    });
    const rest = await look();
    await seg.click();
    await expect(seg).toHaveAttribute('aria-pressed', 'true');
    const on = await look();
    expect(on.bg).toBe(rest.fg);
    expect(on.fg).not.toBe(rest.fg);

    // ── A filter alone shows the ✕, and the ✕ clears it.
    await expect(page.locator('#search')).toHaveValue('');
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(pressed).toHaveCount(0);
    await expect(clear).toBeHidden();
    await expect(rows).toHaveCount(allRows);
    expect((await look()).bg).toBe(rest.bg);

    // ── Search + filter: one ✕ clears both.
    await seg.click();
    await page.fill('#search', 'localhost');
    await expect(rows).toHaveCount(1);
    await clear.click();
    await expect(page.locator('#search')).toHaveValue('');
    await expect(pressed).toHaveCount(0);
    await expect(clear).toBeHidden();
    await expect(rows).toHaveCount(allRows);

    // ── Toggling the segment off by hand hides the ✕ again.
    await seg.click();
    await expect(clear).toBeVisible();
    await seg.click();
    await expect(clear).toBeHidden();
  } finally {
    try { fs.rmSync(path.join(markerDir, session), { force: true }); } catch { /* gone */ }
    try { onBox(`tmux respawn-pane -k -t '=${session}:' "$(tmux show-options -gv default-shell)" -l`); } catch { /* no session */ }
  }
});
