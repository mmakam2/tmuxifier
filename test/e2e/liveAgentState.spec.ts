import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Real-time agent state, end to end: a marker changes on the box and the open
// page shows it within seconds — no reload, and before the page's own 30 s poll
// could have noticed. What this spec pins is server -> browser: the history
// noticing a change, the /live nudge (liveHub.js), and the tab fetching just
// that box (liveLink.ts). The e2e server sweeps every 2 s, so it cannot tell
// the box-side watch stream from the sweep; box -> server is pinned against a
// real sshd by test/agentWatch.integration.test.js.
//
// Same fixture as agentStates.spec.ts: the isolated sshd box, a pane that reads
// as `claude` via argv[0], markers written straight into the fixture home.

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

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

test('a marker change reaches the open page in seconds, without a reload or a full poll', async ({ page }) => {
  test.setTimeout(120000);
  try {
    onBox(`tmux kill-session -t '=${session}' 2>/dev/null; tmux new-session -d -s '${session}' bash -c 'exec -a claude sleep 600'`);
    expect(onBox(`tmux display-message -p -t '=${session}:' '#{pane_current_command}'`).trim()).toBe('claude');
    writeMarker('working', now(), 'prompt');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const badge = row.locator('.badge[class*="badge-agent-"]');
    const titled = (re: RegExp, timeout: number) => expect(badge).toHaveAttribute('title', re, { timeout });

    // Arrival of the starting state is forced with reloads, as in
    // agentStates.spec.ts. The LAST reload also restarts the page's 30 s poll
    // clock, so the window below is clear of it.
    await expect(async () => {
      await page.reload();
      await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
      await titled(new RegExp(`${session}: working`), 4000);
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
    const t0 = Date.now();
    writeMarker('blocked', now(), 'permission');
    await titled(new RegExp(`${session}: blocked · permission`), 10000);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(10000);
    // It was the nudge, not the interval: no whole-fleet series fetch happened,
    // and at least one single-box fetch did.
    expect(fullPolls).toBe(0);
    expect(boxFetches).toBeGreaterThan(0);

    // ── blocked -> done, the same way
    writeMarker('ready', now() + 1, 'stop');
    await titled(new RegExp(`${session}: done`), 10000);
    expect(fullPolls).toBe(0);

    // ── and a change that raises no health event at all (-> working)
    writeMarker('working', now() + 2, 'prompt');
    await titled(new RegExp(`${session}: working`), 10000);
    expect(fullPolls).toBe(0);
  } finally {
    try { fs.rmSync(path.join(markerDir, session), { force: true }); } catch { /* gone */ }
    try { onBox(`tmux kill-session -t '=${session}'`); } catch { /* gone */ }
  }
});
