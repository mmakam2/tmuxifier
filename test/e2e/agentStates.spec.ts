import { test, expect, type Page, type Request } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The four-state agent model end to end: hook marker files on the box →
// server probe → health series → every client surface (sidebar badge,
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
//    all three: the strip counts 3 sessions per marker, and per-box
//    assertions are scoped to the localhost row / card.
//  - The client reads /api/status and /api/health/series on a 30 s interval
//    (main.ts POLL_MS; the server's own 2 s poll only freshens the cache).
//    State ARRIVAL is therefore forced with reloads (boot polls at once);
//    the checks that are about live polling (seen ack exactly once, focus
//    surviving a repaint, done → idle without a reload) wait on observed
//    /api/health/series responses instead, never on fixed sleeps.
//  - The e2e server runs on the operator's host, and its Host Shell sampler
//    (localAgent.js) reads the host's REAL tmux server and ~/.tmuxifier-agent.
//    The strip counts Host Shell sessions too, so whatever the operator's own
//    Claude is doing right now is in the totals. stripReads() adds the Host
//    Shell row's per-state count (read from its badge title in the same DOM
//    pass as the strip) to the fixture's expected count.

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

// The strip segment's text next to the text it should have: `boxSessions`
// fixture sessions plus however many Host Shell sessions are in `state`, both
// read in one evaluate, so they always come from the same repaint.
async function stripReads(page: Page, state: string, boxSessions: number): Promise<string> {
  return page.evaluate(([st, n0]) => {
    const seg = document.querySelector(`#agent-strip .agent-strip-seg[data-state="${st}"]`);
    const title = document.querySelector('.local-shell [data-agent-badge]')?.getAttribute('title') ?? '';
    const local = [...title.matchAll(/(?:^|· )[A-Za-z0-9_-]+: (blocked|done|working|idle)/g)].filter((m) => m[1] === st).length;
    const n = (n0 as number) + local;
    const want = n === 0 ? null : st === 'blocked' ? `${n} need${n === 1 ? 's' : ''} you` : `${n} ${st}`;
    const got = seg ? seg.textContent : null;
    return got === want ? 'ok' : `strip ${st}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
  }, [state, boxSessions] as const);
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

test('agent states reach badge, strip, board, chips; a seen done turns idle', async ({ page }) => {
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
  const seenPosts: { session: string; ts: number }[] = [];
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

    const t0 = now();
    writeMarker(session, 'blocked', t0, 'permission');
    writeMarker(session2, 'ready', t0, 'stop'); // ready/stop = done until seen

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    expect(boxId).toBeTruthy();
    const badge = row.locator('.badge-agent-blocked');

    // ── Sidebar badge: worst state, ×N for several stateful sessions, title
    // naming every session.
    await reloadUntil(page, async () => {
      await expect(badge).toHaveText('blocked ×2', { timeout: 5000 });
    });
    await expect(badge).toHaveAttribute('title', new RegExp(`${session}: blocked · permission`));
    await expect(badge).toHaveAttribute('title', new RegExp(`${session2}: done`));

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

    // ── Standby dashboard board (no pane docked).
    const card = page.locator(`.dash-board .dash-board-col[data-state="blocked"] .dash-card[data-box-id="${boxId}"][data-session="${session}"]`);
    await expect(card.locator('.dash-card-cause')).toHaveText('permission');
    await expect(card.locator('.dash-card-box')).toHaveText('localhost');
    await expect(card.locator('.dash-card-session')).toHaveText(session);
    await expect(card.locator('.dash-card-age')).not.toBeEmpty();
    await expect(page.locator(`.dash-board .dash-board-col[data-state="done"] .dash-card[data-box-id="${boxId}"][data-session="${session2}"]`)).toHaveCount(1);
    await expect(page.locator(`.dash-board .dash-card[data-session="${session}"]`)).toHaveCount(3);

    // ── Clicking the card docks that box on that session; the pane chip.
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
    expect(seenPosts.filter((p) => p.ts === t1)[0]).toEqual({ session, ts: t1 });

    // ── Keyboard focus survives a repaint: rides the same polls.
    await seg('done').focus();
    await morePolls(2);
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-done')).toHaveText('done'); // still unacked server-side
    expect(seenPosts.filter((p) => p.ts === t1).length).toBe(1);
    expect(seenPosts.filter((p) => p.session === session2)).toEqual([]); // not docked → never acked
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
    expect(res.request().postDataJSON()).toEqual({ session, ts: t2 });
    await expect(pane.locator('.pane-header .pane-chip.chip-agent-idle')).toHaveText('idle', { timeout: 45000 });
    expect(seenPosts.filter((p) => p.ts === t2).length).toBe(1);
    // Only localhost acknowledged; its two aliases still read done.
    // localhost: session2 still done (worst), the acked session idle — both count.
    await expect(row.locator('[data-agent-badge]')).toHaveText('done ×2');
    await expect(row.locator('[data-agent-badge]')).toHaveAttribute('title', new RegExp(`${session}: idle`));
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

// A board card for a NON-configured session must dock the pane straight onto
// that session: one /term attach, carrying `session=`. Building the pane on the
// configured session first and switching after would attach there (which can
// create that session and run its startupCommand) and then tear it down.
test('a board card for another session docks the pane on it with a single /term attach', async ({ page }) => {
  test.setTimeout(120000);
  const terms: string[] = [];
  page.on('websocket', (ws) => { if (/\/term\?/.test(ws.url())) terms.push(ws.url()); });
  try {
    onBox(`tmux has-session -t '=${session2}' 2>/dev/null || tmux new-session -d -s '${session2}' bash -c 'exec -a claude sleep 600'`);
    expect(onBox(`tmux display-message -p -t '=${session2}:' '#{pane_current_command}'`).trim()).toBe('claude');
    // blocked, not done: docking a done pane would acknowledge it.
    writeMarker(session2, 'blocked', now(), 'question');

    await login(page);
    const row = page.locator('.box', { has: page.locator('.name', { hasText: /^localhost$/ }) }).first();
    const boxId = (await row.getAttribute('data-id'))!;
    const card = page.locator(`.dash-board .dash-board-col[data-state="blocked"] .dash-card[data-box-id="${boxId}"][data-session="${session2}"]`);
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
