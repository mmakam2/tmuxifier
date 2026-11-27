import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentPanes, resetAgentPanes, writePaneMarker, type AgentPane, type AgentPaneLayout } from './agentPaneBox';

// Real-time agent state, end to end: a marker changes on the box and the open
// page shows it within seconds — no reload, and before the page's own 30 s poll
// could have noticed. What this spec pins is server -> browser: the history
// noticing a change, the /live nudge (liveHub.js), and the tab fetching just
// that box (liveLink.ts). The e2e server sweeps every 2 s, so it cannot tell
// the box-side watch stream from the sweep; box -> server is pinned against a
// real sshd by test/agentWatch.integration.test.js.
//
// Same fixture as agentStates.spec.ts: the isolated sshd box, a pane that reads
// as `claude` via argv[0], markers written straight into the fixture home. The
// first test watches one pane of the window in front; the second one a pane in a
// window BEHIND it (agentPaneBox.ts), where nothing the page does can have
// looked at it.

const cfg = process.env.E2E_SSH_CONFIG!;
const host = process.env.E2E_BOX_HOST!;
const home = process.env.E2E_BOX_HOME!;
const session = `${process.env.E2E_BOX_SESSION!}-live`;
const markerDir = path.join(home, '.tmuxifier-agent');

function onBox(cmd: string): string {
  return execFileSync('ssh', ['-F', cfg, host, cmd], { encoding: 'utf8' });
}
function writeMarker(state: string, epoch: number, cause: string) {
  fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  // Temp file + rename, as the hook does: the watch must never read half a marker.
  fs.writeFileSync(path.join(markerDir, `${session}.tmp`), `${session}:${state}:${epoch}:${cause}\n`, { mode: 0o600 });
  fs.renameSync(path.join(markerDir, `${session}.tmp`), path.join(markerDir, session));
}
const now = () => Math.floor(Date.now() / 1000);

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A sidebar row's tooltip is `<agent> in <name>: <state>`, so a title names the
// pane it is on. The name carries its session only while the box's agents span
// several sessions (`web-live › 0:live`), which whatever other specs left behind
// decides, so that prefix is the one optional part.
const titleOf = (name: string, state: string) =>
  new RegExp(`^Claude in (?:${esc(session)} › )?${esc(name)}: ${esc(state)}$`);

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('a marker change reaches the open page in seconds, without a reload or a full poll', async ({ page }) => {
  test.setTimeout(120000);
  try {
    // The window is named (-n), so tmux's automatic rename leaves it alone: the
    // row's name is `<index>:live`, which the titles below must carry.
    onBox(`tmux kill-session -t '=${session}' 2>/dev/null; tmux new-session -d -s '${session}' -n live bash -c 'exec -a claude sleep 600'`);
    expect(onBox(`tmux display-message -p -t '=${session}:' '#{pane_current_command}'`).trim()).toBe('claude');
    const pane = onBox(`tmux display-message -p -t '=${session}:' '#{pane_id}'`).trim();
    const name = `${onBox(`tmux display-message -p -t '=${session}:' '#{window_index}'`).trim()}:live`;
    writeMarker('working', now(), 'prompt');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    // The session-wide marker speaks for the session's agent pane: its sidebar row.
    const agentRow = page.locator(`li.box-agents[data-agents-for="${boxId}"] .box-agent[data-pane="${pane}"]`);
    const titled = (state: string, timeout: number) => expect(agentRow).toHaveAttribute('title', titleOf(name, state), { timeout });

    // Arrival of the starting state is forced with reloads, as in
    // agentStates.spec.ts. The LAST reload also restarts the page's 30 s poll
    // clock, so the window below is clear of it.
    await expect(async () => {
      await page.reload();
      await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
      await titled('working', 4000);
    }).toPass({ timeout: 40000 });
    await page.waitForTimeout(1500); // let the boot's own fetches finish

    let fullPolls = 0;
    let boxFetches = 0;
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (u.pathname !== '/api/health/series') return;
      if (u.searchParams.has('box')) boxFetches += 1; else fullPolls += 1;
    });

    // ── working -> blocked
    writeMarker('blocked', now(), 'permission');
    await titled('blocked · permission', 10000);
    // It was the nudge, not the interval: no whole-fleet series fetch happened,
    // and at least one single-box fetch did.
    expect(fullPolls).toBe(0);
    expect(boxFetches).toBeGreaterThan(0);

    // ── blocked -> done, the same way
    writeMarker('ready', now() + 1, 'stop');
    await titled('done', 10000);
    expect(fullPolls).toBe(0);

    // ── and a change that raises no health event at all (-> working)
    writeMarker('working', now() + 2, 'prompt');
    await titled('working', 10000);
    expect(fullPolls).toBe(0);
  } finally {
    try { fs.rmSync(path.join(markerDir, session), { force: true }); } catch { /* gone */ }
    try { onBox(`tmux kill-session -t '=${session}'`); } catch { /* gone */ }
  }
});

// Brief item 8 of the pane-level change: the agent is in a window that is NOT in
// front. Its marker changes, and its row follows within seconds on the nudge
// alone (no reload, no whole-fleet series fetch), while the rows of the other
// panes stay as they were and nothing is acknowledged: no one is looking.
test('a marker change in a pane of a background window reaches that pane\'s row, and only that row, without a full poll', async ({ page }) => {
  test.setTimeout(120000);
  let layout: AgentPaneLayout | null = null;
  const seenPosts: unknown[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/agent-seen$/.test(r.url())) seenPosts.push(r.postDataJSON()); });
  try {
    layout = buildAgentPanes(session);
    const { one, twoA, twoB } = layout;
    const t0 = now();
    for (const p of [one, twoA, twoB]) writePaneMarker(session, p.pane, 'working', t0, 'prompt');
    // Window 1 is in front; the pane that changes below is in window 2.
    expect(onBox(`tmux display-message -p -t '=${session}:' '#{window_id}'`).trim()).toBe(one.windowId);
    expect(twoB.windowId).not.toBe(one.windowId);

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    const agentRow = (p: AgentPane) => page.locator(`li.box-agents[data-agents-for="${boxId}"] .box-agent[data-pane="${p.pane}"]`);
    const titled = (p: AgentPane, state: string, timeout: number) => expect(agentRow(p)).toHaveAttribute('title', titleOf(p.name, state), { timeout });
    const allWorking = async (timeout: number) => { for (const p of [one, twoA, twoB]) await titled(p, 'working', timeout); };

    // As above: reloads force the starting state in, and the last one restarts
    // the page's 30 s poll clock.
    await expect(async () => {
      await page.reload();
      await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
      await allWorking(2000);
    }).toPass({ timeout: 40000 });
    await page.waitForTimeout(1500); // let the boot's own fetches finish

    let fullPolls = 0;
    let boxFetches = 0;
    page.on('response', (r) => {
      const u = new URL(r.url());
      if (u.pathname !== '/api/health/series') return;
      if (u.searchParams.has('box')) boxFetches += 1; else fullPolls += 1;
    });

    // ── working -> blocked, behind the window in front
    writePaneMarker(session, twoB.pane, 'blocked', now(), 'permission');
    await titled(twoB, 'blocked · permission', 10000);
    expect(fullPolls).toBe(0);
    expect(boxFetches).toBeGreaterThan(0);
    // Its neighbour in the same window and the pane in front did not move.
    await titled(twoA, 'working', 1000);
    await titled(one, 'working', 1000);

    // ── blocked -> done, the same way; a done agent nobody is looking at stays done
    writePaneMarker(session, twoB.pane, 'ready', now() + 1, 'stop');
    await titled(twoB, 'done', 10000);
    expect(fullPolls).toBe(0);
    await titled(twoA, 'working', 1000);
    await titled(one, 'working', 1000);
    expect(seenPosts).toEqual([]);
  } finally {
    resetAgentPanes(layout, session);
    try { onBox(`tmux kill-session -t '=${session}'`); } catch { /* gone */ }
  }
});
