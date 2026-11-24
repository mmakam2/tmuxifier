import { test, expect, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { writeWorkerRcFiles } from '../helpers/workerBench.js';

// Agent workers end to end (design 5.4): the Edit Box "Agent workers" section and the pane
// picker's "Start Claude in <project>" rows, against the real server, the real starter and the
// isolated sshd fixture (test/helpers/localBox.js). Nothing here is mocked: a start runs the
// starter's script over the box's ControlMaster and makes a real tmux session on the fixture's
// private tmux server (sshd sets TMUX_TMPDIR into the fixture), which this file reads back over
// ssh with exact targets.
//
// The fixture box is shaped like a box setup has run on, the way test/helpers/workerBench.js
// shapes its bench: the rc files get the `tmuxifier-local-bin` PATH line (and the token line,
// inert here: there is no token file), and ~/.local/bin/claude is a stand-in that execs
// ~/.local/libexec/claude, a symlink to a `sleep`, so the pane's command reads `claude` and the
// session stays up. The starter launches `exec "$SHELL" -ic 'exec claude'`, so the stand-in is
// found only through the rc line, as on a real box. Every file this adds is removed, and every
// rc file put back as it was, in afterAll: later specs share the fixture home.
//
// Three facts of the server shape the tests:
// - Saving the Edit Box modal also saves the box (its User field writes `root` onto a seeded
//   box with no user) and always starts a setup job on it, which gates a start
//   (`setup-running`). A test that saves puts the box record back and waits for that job.
// - The starter counts what the server's listing of the box shows; a name it started counts
//   on its own, whatever the listing says, only until two status reads of the box have been
//   applied since (agentWorkers.js). So every start here is followed by a wait for the listing
//   to show the worker running `claude`, and every test that starts workers first waits for a
//   listing with no worker in it (`waitNoListedWorkers`): two applied reads after the previous
//   test's last start, so nothing it started is still counted.
// - A browser pane on a session recreates it when it ends (design 5.8), so cleanup leaves the
//   page before it kills the `worker-*` sessions it made.

const cfg = process.env.E2E_SSH_CONFIG!;
const host = process.env.E2E_BOX_HOST!;
const home = process.env.E2E_BOX_HOME!;
const projectDir = path.join(home, 'opt', 'billing-api');
const RC_FILES = ['.profile', '.bashrc', '.zshrc'];
const EMPTY = { projects: [], mailStart: false, max: 3 };
const CAP_MESSAGE = 'this box already runs as many started agents as its limit allows';

let rcBefore: Record<string, string | null> = {};
const madeFiles: string[] = [];

// Makes `link` a symlink to a `sleep` that still sleeps when invoked by that name. A multicall
// coreutils (uutils, Ubuntu 26.04's default) refuses an argv[0] it has no applet for, so the
// first candidate that runs through the link wins; none is a hard failure, never a skip.
function linkSleepAs(link: string) {
  for (const name of ['sleep', 'gnusleep']) {
    const found = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8' }).stdout.trim();
    if (!found.startsWith('/')) continue;
    fs.rmSync(link, { force: true });
    fs.symlinkSync(found, link);
    if (spawnSync(link, ['0'], { stdio: 'ignore' }).status === 0) return;
  }
  fs.rmSync(link, { force: true });
  throw new Error('no sleep binary runs under another name (tried sleep, gnusleep); the stand-in claude needs one');
}

test.beforeAll(() => {
  rcBefore = Object.fromEntries(RC_FILES.map((f) => {
    const p = path.join(home, f);
    return [f, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null];
  }));
  writeWorkerRcFiles(home);

  const localBin = path.join(home, '.local', 'bin');
  const libexec = path.join(home, '.local', 'libexec');
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(libexec, { recursive: true });
  linkSleepAs(path.join(libexec, 'claude'));
  fs.writeFileSync(path.join(localBin, 'claude'), '#!/bin/sh\nexec "$HOME/.local/libexec/claude" 600\n', { mode: 0o755 });
  madeFiles.push(path.join(localBin, 'claude'), path.join(libexec, 'claude'));
  fs.mkdirSync(projectDir, { recursive: true });
});

test.afterAll(() => {
  for (const f of madeFiles) fs.rmSync(f, { force: true });
  fs.rmSync(path.join(home, 'opt'), { recursive: true, force: true });
  for (const [f, text] of Object.entries(rcBefore)) {
    const p = path.join(home, f);
    if (text === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, text);
  }
});

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function boxOf(page: Page, label: string) {
  const res = await page.request.get('/api/boxes');
  expect(res.ok()).toBeTruthy();
  const b = ((await res.json()) as { id: string; label: string; user?: string; tags?: string[] }[]).find((x) => x.label === label);
  expect(b, `seeded box ${label}`).toBeTruthy();
  return b!;
}

async function openEditModal(page: Page, label = 'localhost') {
  await page.locator('.box', { has: page.locator('.name', { hasText: new RegExp(`^${label}$`) }) }).first().locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  // Agent messaging and agent workers are on the modal's Agents tab.
  await page.getByRole('tab', { name: /^Agents/ }).click();
  return page.locator('.modal.box-modal');
}

async function saveModal(page: Page) {
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0, { timeout: 10000 });
}

async function cancelModal(page: Page) {
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0);
}

async function getWorkers(page: Page, id: string) {
  const res = await page.request.get(`/api/boxes/${id}/workers`);
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

async function putWorkers(page: Page, id: string, data: object) {
  const res = await page.request.put(`/api/boxes/${id}/workers`, { data });
  expect(res.status(), await res.text()).toBe(200);
}

// Until no setup job runs on the box: an Edit Box save starts one, and it gates a start.
async function waitSetupIdle(page: Page, id: string) {
  await expect.poll(async () => {
    const res = await page.request.get(`/api/boxes/${id}/setup`);
    if (res.status() === 204) return 'none';
    return (await res.json()).status;
  }, { timeout: 120000, intervals: [500, 1000] }).not.toBe('running');
}

// A command on the fixture box over ssh (its login shell, its private tmux). Every value is a
// constant of this file.
function onBox(cmd: string): { code: number; out: string } {
  const r = spawnSync('ssh', ['-F', cfg, host, cmd], { encoding: 'utf8', timeout: 20000 });
  return { code: r.status ?? -1, out: r.stdout ?? '' };
}

const hasSession = (name: string) => onBox(`tmux has-session -t '=${name}' 2>/dev/null`).code === 0;

function workerSessions(): string[] {
  return onBox("tmux list-sessions -F '#{session_name}' 2>/dev/null || true").out
    .split('\n').map((s) => s.trim()).filter((s) => /^worker-[a-z0-9-]+$/.test(s));
}

// Every worker-* session on the fixture's tmux, by exact target, until none is left.
async function killWorkers() {
  await expect.poll(() => {
    for (const s of workerSessions()) onBox(`tmux kill-session -t '=${s}' 2>/dev/null || true`);
    return workerSessions();
  }, { timeout: 20000, intervals: [500, 1000] }).toEqual([]);
}

async function paneCmdOf(page: Page, id: string, session: string) {
  const res = await page.request.get(`/api/status?box=${encodeURIComponent(id)}`);
  const sessions = ((await res.json())?.[id]?.sessions ?? []) as { name: string; paneCmd: string }[];
  return sessions.find((s) => s.name === session)?.paneCmd ?? null;
}

// Until the server's listing of the box shows no worker-* session (what the starter counts).
async function waitNoListedWorkers(page: Page, id: string) {
  await expect.poll(async () => {
    const res = await page.request.get(`/api/status?box=${encodeURIComponent(id)}`);
    return (((await res.json())?.[id]?.sessions ?? []) as { name: string }[]).map((s) => s.name).filter((n) => n.startsWith('worker-'));
  }, { timeout: 20000, intervals: [500, 1000] }).toEqual([]);
}

async function openPane(page: Page, label: string) {
  await page.locator('.box .name', { hasText: new RegExp(`^${label}$`) }).click();
  const pane = page.locator('.stage-pane').first();
  await expect(pane.locator('.xterm-rows')).toContainText(/[#$%>]/, { timeout: 15000 });
  return pane;
}

// Pick the picker's start row for `project`; resolves once the click is made.
async function pickStart(page: Page, pane: ReturnType<Page['locator']>, project: string) {
  const picker = pane.locator('.session-picker');
  await picker.locator('.session-picker-trigger').click();
  const row = picker.locator('.session-picker-row.start', { hasText: `Start Claude in ${project}` });
  await expect(row).toHaveCount(1, { timeout: 10000 });
  return row;
}

// Opens the pane's picker and returns the row of session `name`.
async function sessionRow(pane: ReturnType<Page['locator']>, name: string) {
  const picker = pane.locator('.session-picker');
  await picker.locator('.session-picker-trigger').click();
  const row = picker.locator(`.session-picker-row[data-key="s:${name}"]`);
  await expect(row).toHaveCount(1, { timeout: 10000 });
  return row;
}

// The session the pane's picker marks current (its row key is `s:<session>` or `w:<session>:@id`).
async function currentSession(pane: ReturnType<Page['locator']>) {
  const key = await pane.locator('.session-picker-row.current').first().getAttribute('data-key').catch(() => null);
  const m = /^(?:s:(.+)|w:(.+):@\d+)$/.exec(key ?? '');
  return m ? (m[1] ?? m[2]) : null;
}

// The fields an Edit Box save in this file writes onto the seeded box, put back.
async function restoreBox(page: Page, before: { id: string; user?: string; tags?: string[] }) {
  await page.request.patch(`/api/boxes/${before.id}`, { data: { user: before.user ?? null, tags: before.tags ?? [] } });
  const after = await boxOf(page, 'localhost');
  expect({ user: after.user, tags: after.tags }).toEqual({ user: before.user, tags: before.tags });
}

test('the Edit Box section adds a project with its trust tick and cap, saves them, and removes it again', async ({ page }) => {
  test.setTimeout(240000);
  await login(page);
  const box = await boxOf(page, 'localhost');
  const mailOn = (await (await page.request.get('/api/ui-config')).json()).agentMail === true;
  try {
    await putWorkers(page, box.id, EMPTY);
    let modal = await openEditModal(page);
    let section = modal.locator('.wk-section');
    await expect(section.getByText('No projects: no agent can be started on this box')).toBeVisible({ timeout: 10000 });
    // The messaging tick follows what the server says messaging is.
    await expect(section.getByLabel('Let agent messages start an agent here')).toHaveCount(mailOn ? 1 : 0);
    expect((await getWorkers(page, box.id)).mail).toBe(mailOn);

    await section.getByRole('button', { name: 'Add project' }).click();
    // The new row's name field takes focus.
    await expect(section.getByLabel('Project 1 name')).toBeFocused();
    await section.getByLabel('Project 1 name').fill('api');
    await section.getByLabel('Project 1 directory').fill(projectDir);
    await section.getByLabel("Skip Claude's folder-trust question").check();
    await section.getByRole('spinbutton').fill('2');
    if (mailOn) await section.getByLabel('Let agent messages start an agent here').check();
    await expect(section.locator('.wk-note.bad')).toHaveCount(0);
    await saveModal(page);

    expect((await getWorkers(page, box.id)).workers).toEqual({
      projects: [{ name: 'api', dir: projectDir, trust: true }], mailStart: mailOn, max: 2,
    });
    await waitSetupIdle(page, box.id);

    modal = await openEditModal(page);
    section = modal.locator('.wk-section');
    await expect(section.getByLabel('Project 1 name')).toHaveValue('api', { timeout: 10000 });
    await expect(section.getByLabel('Project 1 directory')).toHaveValue(projectDir);
    await expect(section.getByLabel("Skip Claude's folder-trust question")).toBeChecked();
    await expect(section.getByRole('spinbutton')).toHaveValue('2');
    if (mailOn) await expect(section.getByLabel('Let agent messages start an agent here')).toBeChecked();

    await section.getByRole('button', { name: 'Remove project 1' }).click();
    await expect(section.getByLabel('Project 1 name')).toHaveCount(0);
    await expect(section.getByText('No projects: no agent can be started on this box')).toBeVisible();
    await saveModal(page);
    expect((await getWorkers(page, box.id)).workers).toEqual({ projects: [], mailStart: mailOn, max: 2 });
  } finally {
    try {
      await waitSetupIdle(page, box.id);
      await restoreBox(page, box);
    } finally {
      await putWorkers(page, box.id, EMPTY);
    }
  }
});

test('a bad name or directory shows the row\'s problem, and a save keeps the box\'s fields but not the section', async ({ page }) => {
  await login(page);
  const box = await boxOf(page, 'localhost');
  try {
    await putWorkers(page, box.id, EMPTY);
    const modal = await openEditModal(page);
    const section = modal.locator('.wk-section');
    await expect(section.getByText('No projects: no agent can be started on this box')).toBeVisible({ timeout: 10000 });
    await section.getByRole('button', { name: 'Add project' }).click();
    const note = section.locator('.wk-row .wk-note');

    await section.getByLabel('Project 1 name').fill('API');
    await expect(note).toHaveText('Name: lowercase letters, digits and dashes, up to 24');
    await expect(note).toHaveClass(/\bbad\b/);
    await section.getByLabel('Project 1 name').fill('api');
    await section.getByLabel('Project 1 directory').fill(projectDir);
    await expect(note).toHaveText('');
    await expect(note).not.toHaveClass(/\bbad\b/);
    await section.getByLabel('Project 1 directory').fill(`${projectDir}/my project`);
    await expect(note).toHaveText('Directory: an absolute path with no spaces');
    await expect(note).toHaveClass(/\bbad\b/);

    // A box field changed in the same save (the tag: it does not touch how the box is reached):
    // the box is saved, the section is not.
    // The tag is on the Box tab; Save is pressed from there, with the bad row out of sight.
    await page.getByRole('tab', { name: /^Box/ }).click();
    await modal.getByLabel('Tag', { exact: true }).fill('e2etag');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(modal.locator('p.err')).toHaveText('Box saved, but the agent worker settings were not: Directory: an absolute path with no spaces', { timeout: 10000 });
    // The refusal brings the tab it is about back, so the message and the row are seen together.
    await expect(page.getByRole('tab', { name: /^Agents/ })).toHaveAttribute('aria-selected', 'true');
    await expect(note).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
    expect((await boxOf(page, 'localhost')).tags).toEqual(['e2etag']);
    expect((await getWorkers(page, box.id)).workers).toEqual(EMPTY);
    await cancelModal(page);
  } finally {
    await restoreBox(page, box);
    await putWorkers(page, box.id, EMPTY);
  }
});

test('at a phone-width viewport the section\'s rows stay inside the modal', async ({ page }) => {
  await login(page);
  const box = await boxOf(page, 'localhost');
  try {
    await putWorkers(page, box.id, { projects: [{ name: 'billing-api-long-name-24', dir: `${projectDir}/with/a/rather/long/path/below/it`, trust: false }], mailStart: false, max: 3 });
    const modal = await openEditModal(page);
    const section = modal.locator('.wk-section');
    await expect(section.getByLabel('Project 1 name')).toHaveValue('billing-api-long-name-24', { timeout: 10000 });
    // A problem line too, so the longest note is laid out.
    await section.getByRole('spinbutton').fill('9');
    await expect(section.locator('.wk-note.bad')).toHaveText('Worker sessions: a whole number from 1 to 8');
    await page.setViewportSize({ width: 344, height: 760 });
    // Laid out at that width, not left at the desktop one.
    await expect.poll(() => section.evaluate((n) => n.getBoundingClientRect().width)).toBeLessThan(344 - 32 + 1);
    await expect.poll(() => section.evaluate((n) => n.scrollWidth - n.clientWidth)).toBeLessThanOrEqual(0);
    // Every control of every row inside the section's box (an overflowing child of a grid or
    // flex row need not widen the section's scrollWidth when the row clips it).
    const outside = await section.evaluate((n) => {
      const s = n.getBoundingClientRect();
      return [...n.querySelectorAll('.wk-row > *, .wk-max-row > *')].flatMap((c) => {
        const r = c.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return []; // not rendered (an empty note)
        return r.left >= s.left - 0.5 && r.right <= s.right + 0.5 ? [] : [`${c.className || c.tagName}: ${Math.round(r.left)}..${Math.round(r.right)} outside ${Math.round(s.left)}..${Math.round(s.right)}`];
      });
    });
    expect(outside).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 720 });
    await cancelModal(page);
  } finally {
    await putWorkers(page, box.id, EMPTY);
  }
});

test('the picker\'s start row starts worker-api-1 and moves the pane there; a second start gives worker-api-2', async ({ page }) => {
  test.setTimeout(180000);
  await login(page);
  const box = await boxOf(page, 'localhost');
  try {
    await killWorkers();
    await waitNoListedWorkers(page, box.id);
    await waitSetupIdle(page, box.id);
    await putWorkers(page, box.id, { projects: [{ name: 'api', dir: projectDir, trust: false }], mailStart: false, max: 3 });

    const pane = await openPane(page, 'localhost');
    const row = await pickStart(page, pane, 'api');
    // Below every session and window row, and no kill ×.
    const kinds = await pane.locator('.session-picker-row').evaluateAll((rows) => rows.map((r) => r.classList.contains('start')));
    expect(kinds.at(-1)).toBe(true);
    expect(kinds.indexOf(true)).toBeGreaterThan(0);
    expect(kinds.slice(kinds.indexOf(true)).every(Boolean)).toBe(true);
    await expect(row.locator('.session-picker-kill')).toHaveCount(0);

    // The pane really attaches there: its terminal reopens on the worker's session.
    let attached = page.waitForEvent('websocket', { predicate: (ws) => /\/term\?.*[?&]session=worker-api-1(&|$)/.test(ws.url()), timeout: 20000 });
    await row.locator('.session-picker-pick').click();
    // The pick says at once that the start began (an info toast, not an error).
    await expect(page.locator('.toast-info', { hasText: 'Starting Claude in api…' })).toBeVisible({ timeout: 5000 });
    await attached;
    await expect.poll(() => currentSession(pane), { timeout: 20000 }).toBe('worker-api-1');
    expect(hasSession('worker-api-1')).toBe(true);
    await expect.poll(() => paneCmdOf(page, box.id, 'worker-api-1'), { timeout: 20000, intervals: [500, 1000] }).toBe('claude');

    const again = await pickStart(page, pane, 'api');
    attached = page.waitForEvent('websocket', { predicate: (ws) => /\/term\?.*[?&]session=worker-api-2(&|$)/.test(ws.url()), timeout: 20000 });
    await again.locator('.session-picker-pick').click();
    await attached;
    await expect.poll(() => currentSession(pane), { timeout: 20000 }).toBe('worker-api-2');
    expect(hasSession('worker-api-2')).toBe(true);
    await expect.poll(() => paneCmdOf(page, box.id, 'worker-api-2'), { timeout: 20000, intervals: [500, 1000] }).toBe('claude');
  } finally {
    await page.goto('about:blank');
    await killWorkers();
    await page.request.put(`/api/boxes/${box.id}/workers`, { data: EMPTY });
  }
});

test('with a cap of one, a second start says the box is at its limit and starts nothing', async ({ page }) => {
  test.setTimeout(180000);
  await login(page);
  const box = await boxOf(page, 'localhost');
  try {
    await killWorkers();
    await waitNoListedWorkers(page, box.id);
    await waitSetupIdle(page, box.id);
    await putWorkers(page, box.id, { projects: [{ name: 'api', dir: projectDir, trust: false }], mailStart: false, max: 1 });

    const pane = await openPane(page, 'localhost');
    await (await pickStart(page, pane, 'api')).locator('.session-picker-pick').click();
    await expect.poll(() => currentSession(pane), { timeout: 20000 }).toBe('worker-api-1');
    await expect.poll(() => paneCmdOf(page, box.id, 'worker-api-1'), { timeout: 20000, intervals: [500, 1000] }).toBe('claude');

    await (await pickStart(page, pane, 'api')).locator('.session-picker-pick').click();
    await expect(page.locator('.toast-error', { hasText: CAP_MESSAGE })).toBeVisible({ timeout: 10000 });
    expect(await currentSession(pane)).toBe('worker-api-1');
    expect(workerSessions()).toEqual(['worker-api-1']);
  } finally {
    await page.goto('about:blank');
    await killWorkers();
    await page.request.put(`/api/boxes/${box.id}/workers`, { data: EMPTY });
  }
});

test('with a cap of one, a worker killed with the picker\'s × can be started again at once, under its own name', async ({ page }) => {
  test.setTimeout(180000);
  await login(page);
  const box = await boxOf(page, 'localhost');
  try {
    await killWorkers();
    await waitNoListedWorkers(page, box.id);
    await waitSetupIdle(page, box.id);
    await putWorkers(page, box.id, { projects: [{ name: 'api', dir: projectDir, trust: false }], mailStart: false, max: 1 });

    const pane = await openPane(page, 'localhost');
    const own = await currentSession(pane);
    expect(own).toBeTruthy();
    const firstStart = Date.now();
    await (await pickStart(page, pane, 'api')).locator('.session-picker-pick').click();
    await expect.poll(() => currentSession(pane), { timeout: 20000 }).toBe('worker-api-1');
    await expect.poll(() => paneCmdOf(page, box.id, 'worker-api-1'), { timeout: 20000, intervals: [500, 1000] }).toBe('claude');

    // Back to the pane's own session first: a pane on a session recreates it when it ends
    // (design 5.8), and a recreated worker-api-1 shell would rightly keep its number.
    await (await sessionRow(pane, own!)).locator('.session-picker-pick').click();
    await expect.poll(() => currentSession(pane), { timeout: 20000 }).toBe(own);

    // The ×: the first click arms, the second kills.
    const kill = (await sessionRow(pane, 'worker-api-1')).locator('.session-picker-kill');
    await kill.click();
    await expect(kill).toHaveClass(/armed/);
    await kill.click();
    await expect.poll(() => hasSession('worker-api-1'), { timeout: 15000 }).toBe(false);
    const trigger = pane.locator('.session-picker-trigger');
    if ((await trigger.getAttribute('aria-expanded')) === 'true') await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // The listing, not the starter's memory: the kill route's re-probe may have joined a read
    // that began before the kill, and then the listing itself still shows the worker.
    await waitNoListedWorkers(page, box.id);

    // Inside START_MEMORY_MS (60 s, agentWorkers.js) of the first start, so it is the listing,
    // not the memory running out, that lets the killed worker go.
    expect(Date.now() - firstStart).toBeLessThan(60000);
    await (await pickStart(page, pane, 'api')).locator('.session-picker-pick').click();
    await expect.poll(() => currentSession(pane), { timeout: 20000 }).toBe('worker-api-1');
    expect(hasSession('worker-api-1')).toBe(true);
    await expect.poll(() => paneCmdOf(page, box.id, 'worker-api-1'), { timeout: 20000, intervals: [500, 1000] }).toBe('claude');
    await expect(page.locator('.toast-error', { hasText: CAP_MESSAGE })).toHaveCount(0);
    expect(workerSessions()).toEqual(['worker-api-1']);
  } finally {
    await page.goto('about:blank');
    await killWorkers();
    await page.request.put(`/api/boxes/${box.id}/workers`, { data: EMPTY });
  }
});

test('the three worker routes refuse a device token', async ({ page, playwright }) => {
  await login(page);
  const box = await boxOf(page, 'localhost');
  const device = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:7438' });
  let deviceId: string | null = null;
  try {
    const enrolled = await device.post('/api/devices/enroll', { data: { password: 'e2e', name: 'e2e-workers' } });
    expect(enrolled.status(), await enrolled.text()).toBe(200);
    const { id, token } = await enrolled.json();
    deviceId = id;
    const headers = { Authorization: `Bearer ${token}` };
    // The token works where a device may go, so the refusals below are about the routes.
    expect((await device.get('/api/boxes', { headers })).status()).toBe(200);
    const calls = [
      device.get(`/api/boxes/${box.id}/workers`, { headers }),
      device.put(`/api/boxes/${box.id}/workers`, { headers, data: { projects: [{ name: 'api', dir: projectDir }] } }),
      device.post(`/api/boxes/${box.id}/workers/start`, { headers, data: { project: 'api' } }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status(), `${res.url()} ${await res.text()}`).toBe(403);
      expect(await res.json()).toEqual({ error: 'browser session required' });
    }
    expect((await getWorkers(page, box.id)).workers).toEqual(EMPTY);
    expect(workerSessions()).toEqual([]);
  } finally {
    if (deviceId) await page.request.delete(`/api/devices/${deviceId}`);
    await device.dispose();
  }
});
