import { test, expect } from '@playwright/test';

// Acceptance test for the whole feature: box "setup" (installing tmux etc.
// over SSH) used to run as a WebSocket-tied PTY, so closing the setup panel
// (or a dropped connection) killed the in-progress script. It is now a
// durable server-side job (setupManager.js / setupStore.js): POST
// /api/boxes/:id/setup spawns the ssh child and returns immediately: the
// child is not attached to the HTTP response or to any WebSocket, so nothing
// the browser does afterward can touch it. The client-side ".provision-close"
// button (openProvisionPanel/closeProvisionPanel in src/web/main.ts) only
// clears local poll timers and hides the panel — it never calls an API that
// could cancel the job. Only DELETE /api/boxes/:id does that
// (setupManager.cancelForBox, wired in server.js), which this test never
// calls until after the job is already done. This spec exercises all of that
// through the real UI + real API, not by asserting on the source code.
//
// Setup options are deliberately minimal — shell framework "None" (the
// default) and "Install Oh My Tmux if missing" unchecked — so the generated
// script never touches the network (no `git clone` of gpakosz/.tmux, no
// oh-my-zsh/oh-my-bash curl installers; see buildEnsureTmuxRemote in
// src/server/boxActions.js). It only ensures git/tmux are present and starts
// a session, which the local sshd fixture (this machine, already has both)
// completes deterministically — the job is expected to reach 'done'.
// 'needs-interactive' is also accepted, for a fixture whose SSH user needs a
// sudo password to install a missing package.
test('setup continues server-side after the panel is closed mid-run', async ({ page }) => {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });

  const label = `setup-e2e-${Date.now()}`;

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

  // (a) A job is running.
  await expect(panel.locator('.provision-status')).toContainText(/running|waiting/i, { timeout: 5000 });

  // (b) Close the panel mid-run — the whole point of this feature.
  await page.locator('.provision-close').click();
  await expect(panel).not.toHaveClass(/open/);

  // Look the box up by its label to get an id — the sidebar itself is not
  // refreshed by the add flow (only a completed setup job triggers refresh()),
  // so this is the reliable way to correlate the setup job to our box.
  const boxesRes = await page.request.get('/api/boxes');
  const boxes: Array<{ id: string; label: string }> = await boxesRes.json();
  const box = boxes.find((b) => b.label === label);
  expect(box).toBeTruthy();
  const boxId = box!.id;

  try {
    // (c) The job keeps running server-side with the panel closed — poll the
    // API directly (no UI involved at all) until it reaches a terminal state.
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/setup');
          const jobs: Array<{ boxId: string; status: string }> = await res.json();
          return jobs.find((j) => j.boxId === boxId)?.status;
        },
        { timeout: 30000 },
      )
      .toMatch(/^(done|needs-interactive)$/);

    const finalRes = await page.request.get('/api/setup');
    const finalJobs: Array<{ boxId: string; status: string }> = await finalRes.json();
    const finalJob = finalJobs.find((j) => j.boxId === boxId);
    expect(finalJob?.status).toBe('done');
  } finally {
    // Best-effort cleanup: remove the box (also kills its tmux session on the
    // box in the background — see boxRemoval.js) so repeated runs don't pile
    // up sessions on the fixture host.
    await page.request.delete(`/api/boxes/${boxId}`);
  }
});
