import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Acceptance test for the whole feature: box "setup" (installing tmux etc.
// over SSH) used to run as a WebSocket-tied PTY, so closing the setup panel
// (or a dropped connection) killed the in-progress script. It is now a
// durable server-side job (setupManager.js / setupStore.js): POST
// /api/boxes/:id/setup spawns the ssh child and returns immediately: the
// child is not attached to the HTTP response or to any WebSocket, so nothing
// the browser does afterward can touch it.
//
// What this test actually proves, precisely:
//   1. The setup job runs to completion server-side (polled via GET
//      /api/setup, never through the UI, so the panel's own lifecycle can't
//      influence the read).
//   2. Closing the panel issues no request that could cancel/remove the job.
//      closeProvisionPanel() (src/web/main.ts) only clears a local poll timer
//      and disposes any live interactive-sudo terminal — it makes zero
//      network calls. The only path that can cancel a job is
//      setupManager.cancelForBox, reachable solely via DELETE
//      /api/boxes/:id (server.js). A request recorder, armed before the
//      close click, asserts no such call is ever issued by the page through
//      job completion — so the "close is inert" guarantee is checked
//      deterministically, not by racing the close click against the job's
//      (sub-20ms, on this warm-ControlMaster fixture) actual finish time.
//
// Setup options are deliberately minimal — shell framework "None" (the
// default) and "Install Oh My Tmux if missing" unchecked — so the generated
// script never touches the network (no `git clone` of gpakosz/.tmux, no
// oh-my-zsh/oh-my-bash curl installers; see buildEnsureTmuxRemote in
// src/server/boxActions.js). It only ensures git/tmux are present and starts
// a session, which the local sshd fixture (this machine, already has both)
// completes deterministically — the job is expected to reach 'done'.
test('setup continues server-side after the panel is closed mid-run', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });

  const label = `setup-e2e-${Date.now()}`;
  let boxId: string | undefined;

  // Recorder for any request that could cancel/remove the job. cancelForBox
  // is reachable only via DELETE /api/boxes/:id; a setup cancel would show up
  // as that DELETE, or (defensively) a second POST .../setup issued after the
  // close click. `closed` gates the POST branch so the *initial* POST that
  // starts the job (fired once, at Add box submit, well before close) is
  // never miscounted. Armed here, before any UI interaction, so it can't
  // possibly miss a call — the `closed` flag is what actually scopes the
  // assertion to "from the close click onward".
  const mutatingCalls: string[] = [];
  let closed = false;
  page.on('request', (req) => {
    const m = req.method();
    const u = new URL(req.url()).pathname;
    if (m === 'DELETE' && /^\/api\/boxes\//.test(u)) mutatingCalls.push(`${m} ${u}`);
    else if (closed && m === 'POST' && /^\/api\/boxes\/[^/]+\/setup$/.test(u)) mutatingCalls.push(`${m} ${u}`);
  });

  try {
    await page.locator('#add').click();
    await expect(page.getByRole('heading', { name: 'Add box' })).toBeVisible();

    // Same underlying local sshd fixture as the seeded boxes (see
    // test/e2e/global-setup.js), through a fourth alias reserved for this spec
    // — box hosts must be unique (store.js rejects a duplicate host) and
    // 'tmuxifierlocal'/'-db'/'-worker' are already taken by the seeded boxes.
    await page.getByLabel('Host or alias').fill('tmuxifierlocal-setupjob');
    await page.getByLabel('Label (optional)').fill(label);
    // The User field defaults to 'root'; clear it so the connection falls
    // through to the ssh_config alias's own User directive (the fixture's
    // ephemeral key is only authorized for that user, not root).
    await page.getByLabel('User').fill('');
    // Avoid any option that needs the network — see file header.
    await page.getByLabel('Install Oh My Tmux if missing').uncheck();

    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // The Add Box modal is gone and the setup panel — the SAME shared
    // '#provision-panel' the Proxmox provisioning flow uses — is open.
    // openProvisionPanel() always starts a setup job for a freshly added box,
    // unconditionally, regardless of which options were picked.
    await expect(page.getByRole('heading', { name: 'Add box' })).toBeHidden();
    const panel = page.locator('#provision-panel');
    await expect(panel).toHaveClass(/open/);

    // (a) A job is running. This POST path never sets waitForSsh (only
    // Proxmox provisioning does — see setupManager.start), so the job's
    // status is always 'running' here; it never enters the 'waiting-ssh'
    // phase that would render "Waiting for SSH…" instead.
    await expect(panel.locator('.provision-status')).toContainText(/running/i, { timeout: 5000 });

    // (b) Close the panel mid-run — the whole point of this feature. Flip
    // `closed` immediately before the click so the recorder above starts
    // counting POST .../setup calls from exactly this point on.
    closed = true;
    await page.locator('.provision-close').click();
    await expect(panel).not.toHaveClass(/open/);

    // Look the box up by its label to get an id — the sidebar itself is not
    // refreshed by the add flow (only a completed setup job triggers refresh()),
    // so this is the reliable way to correlate the setup job to our box.
    const boxesRes = await page.request.get('/api/boxes');
    const boxes: Array<{ id: string; label: string }> = await boxesRes.json();
    const box = boxes.find((b) => b.label === label);
    expect(box).toBeTruthy();
    boxId = box!.id;

    // (c) The job keeps running server-side with the panel closed — poll the
    // API directly (no UI involved at all) until it reaches a terminal state.
    // Held in `finalStatus` so the strict check below doesn't need its own
    // extra round trip.
    let finalStatus: string | undefined;
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/setup');
          const jobs: Array<{ boxId: string; status: string }> = await res.json();
          finalStatus = jobs.find((j) => j.boxId === boxId)?.status;
          return finalStatus;
        },
        { timeout: 30000 },
      )
      .toMatch(/^(done|needs-interactive)$/);

    // Strict: this fixture (this machine, already has git+tmux) should never
    // need sudo, so 'needs-interactive' would itself be a surprise worth failing on.
    expect(finalStatus).toBe('done');

    // (d) The actual proof that closing did not cancel the job: no DELETE
    // /api/boxes/:id (or repeat POST .../setup) was ever issued by the page
    // from the close click through job completion.
    expect(mutatingCalls).toEqual([]);
  } finally {
    // Always remove the box we created, even if an assertion above threw
    // partway through — this fixture host is shared across runs/specs, so a
    // leaked box (and its tmux session) would accumulate. Re-resolve by label
    // if the earlier lookup never ran (e.g. failure before boxId was set).
    if (!boxId) {
      const boxesRes = await page.request.get('/api/boxes').catch(() => null);
      if (boxesRes) {
        const boxes: Array<{ id: string; label: string }> = await boxesRes.json();
        boxId = boxes.find((b) => b.label === label)?.id;
      }
    }
    // Also kills the box's tmux session on the box in the background — see
    // boxRemoval.js — so repeated runs don't pile up sessions on the fixture host.
    if (boxId) await page.request.delete(`/api/boxes/${boxId}`);
  }
});

// The opencode-plugin phase end to end, on a box WITHOUT OpenCode: the phase is
// gated on the `opencode` tool, the box decides by its own presence check
// (opencodeAgentPlugin.js), and a box that has no OpenCode records a skip that
// never fails the job — then the setup viewer renders that result.
//
// Network: ticking `opencode` runs the catalog block (boxActions.js), which
// fetches https://opencode.ai/v2/install with curl and runs it. The fixture box
// puts its own bin/ first on PATH (test/helpers/localBox.js — the same place
// its inert chsh/sudo live), so this test parks a stub `curl` there for its
// duration: for exactly that URL it writes an installer that exits 0 and
// installs nothing; any other URL fails loudly, so nothing else can quietly
// "succeed" offline. Nothing leaves the machine. The stub also satisfies the
// implied `curl` tool's `command -v curl` guard, so no package install runs.
// The result is the real catalog block, the real phase and the real pusher
// over the real ssh transport, with OpenCode genuinely absent afterwards.
//
// The PATH line the catalog block appends (# tmuxifier-opencode-bin) lands in
// the fixture's shared rc files, so they are restored afterwards along with the
// stub.
test('the opencode-plugin phase records a skip on a box without OpenCode', async ({ page }) => {
  const home = process.env.E2E_BOX_HOME!;
  const stub = path.join(home, 'bin', 'curl');
  const rcFiles = ['.profile', '.bashrc', '.zshrc'].map((f) => path.join(home, f));
  const rcBefore = new Map(rcFiles.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f) : null]));
  // A box that already had OpenCode would take the applied path instead.
  expect(fs.existsSync(path.join(home, '.opencode'))).toBe(false);
  expect(fs.existsSync(stub)).toBe(false);
  fs.writeFileSync(stub, [
    '#!/bin/sh',
    'out=; url=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out="$2"; shift 2 ;;',
    '    -*) shift ;;',
    '    *) url="$1"; shift ;;',
    '  esac',
    'done',
    'if [ "$url" = "https://opencode.ai/v2/install" ] && [ -n "$out" ]; then',
    "  printf '#!/bin/sh\\nexit 0\\n' > \"$out\"",
    '  exit 0',
    'fi',
    'echo "e2e curl stub: refusing $url" >&2',
    'exit 22',
    '',
  ].join('\n'), { mode: 0o755 });

  const label = `setup-opencode-e2e-${Date.now()}`;
  let boxId: string | undefined;
  try {
    await page.goto('/');
    await page.fill('#pw', 'e2e');
    await page.click('button:has-text("Unlock")');
    await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });

    await page.locator('#add').click();
    await expect(page.getByRole('heading', { name: 'Add box' })).toBeVisible();
    // The alias reserved for this spec file (see the test above).
    await page.getByLabel('Host or alias').fill('tmuxifierlocal-setupjob');
    await page.getByLabel('Label (optional)').fill(label);
    await page.getByLabel('User').fill('');
    await page.getByLabel('Install Oh My Tmux if missing').uncheck();
    await page.getByLabel('OpenCode (CLI + agent-state plugin)').check();
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const panel = page.locator('#provision-panel');
    await expect(panel).toHaveClass(/open/);
    // The viewer appends each phase result to the status line on 'done' (and
    // auto-closes the panel 5 s later, so this is read while it is open).
    await expect(panel.locator('.provision-status')).toContainText('opencode-plugin skipped (no OpenCode on the box)', { timeout: 30000 });

    const boxes: Array<{ id: string; label: string }> = await (await page.request.get('/api/boxes')).json();
    boxId = boxes.find((b) => b.label === label)?.id;
    expect(boxId).toBeTruthy();
    const jobs: Array<{ boxId: string; status: string; options: { tools?: string[] }; opencodePlugin: unknown }> =
      await (await page.request.get('/api/setup')).json();
    const job = jobs.find((j) => j.boxId === boxId);
    expect(job?.status).toBe('done');
    expect(job?.options.tools).toContain('opencode');
    expect(job?.opencodePlugin).toEqual({ target: 'opencode-plugin', ok: false, skipped: 'no OpenCode on the box' });
    // Skipped means nothing was written.
    expect(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'tmuxifier-agent.js'))).toBe(false);
  } finally {
    fs.rmSync(stub, { force: true });
    for (const [f, before] of rcBefore) {
      if (before === null) fs.rmSync(f, { force: true });
      else fs.writeFileSync(f, before);
    }
    if (!boxId) {
      const res = await page.request.get('/api/boxes').catch(() => null);
      if (res) {
        const boxes: Array<{ id: string; label: string }> = await res.json();
        boxId = boxes.find((b) => b.label === label)?.id;
      }
    }
    if (boxId) await page.request.delete(`/api/boxes/${boxId}`);
  }
});
