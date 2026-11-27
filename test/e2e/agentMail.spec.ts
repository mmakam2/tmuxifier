import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { markerDir, now, onBox, writePaneMarker } from './agentPaneBox';

// Agent messaging end to end (design 6.4, 6.5, 6.11): the Edit Box modal's policy section, the
// Messages drawer with a thread view and Stop, and the Refused tab, against the real server,
// the real forward and the isolated sshd fixture (test/helpers/localBox.js).
//
// A message is sent "from the box" exactly as tmx would: curl on the box, over ssh, against the
// forwarded socket ~/.tmuxifier-mail/sock (form fields session, to, body), the way
// test/agentMailForward.integration.test.js drives it. "Running an agent" is a pane that reads
// as `claude` and carries its own marker in the fixture home's ~/.tmuxifier-agent (agent state
// is per pane, see agentPaneBox.ts), read by the server's 2 s status sweep; a marker for a
// session no live agent pane belongs to speaks for nothing.
//
// The one fixture fact that shapes this file: localhost, db-primary and untagged-worker are
// three ssh aliases of ONE fixture account and home, so every box with a messaging switch on
// forwards onto the SAME box-side path, ~/.tmuxifier-mail/sock (a known limitation of this
// version: two entries for one machine fight over one socket). Here it is worse than "the last
// forward wins": the three aliases share one HostName, port and user, so their ControlPath (%C)
// is the same and they share ONE ControlMaster. On a shared master the second `-O forward` for
// that path routes to the FIRST box's listener (so it never verifies), and its failure path
// (`rm -f` of the box-side file, then `-O cancel`) leaves no listener behind at all: with two box
// entries switched on, nobody's socket works. The forward keeper now refuses the second entry on
// a shared master (state `error`, `shares a connection with <first box>`) and leaves the first
// one's socket alone; the last test here pins that. The other tests that send from the box
// switch on localhost alone: the drawer
// thread is between two sessions of localhost (send and receive on, no list entry, design 6.2),
// and the refusal is a send localhost is not allowed. The cross-box pair is covered where it
// needs no working socket: the policy editor test's pair lines. The thread's participants are
// asserted through the API, which proves the attribution rather than assuming it. Every test
// starts and ends with every box's policy empty and every forward torn down (status `off`).

const cfg = process.env.E2E_SSH_CONFIG!;
const host = process.env.E2E_BOX_HOST!;
const boxSession = process.env.E2E_BOX_SESSION!; // every seeded box's configured session
const LABELS = ['localhost', 'db-primary', 'untagged-worker'] as const;
type Label = typeof LABELS[number];
const OFF = { send: false, sendTo: [], receive: false, receiveFrom: [] };

async function login(page: Page) {
  await page.goto('/');
  await page.fill('#pw', 'e2e');
  await page.click('button:has-text("Unlock")');
  await expect(page.locator('.box .name', { hasText: 'localhost' })).toBeVisible({ timeout: 10000 });
}

async function openEditModal(page: Page, label = 'localhost') {
  await page.locator('.box', { has: page.locator('.name', { hasText: new RegExp(`^${label}$`) }) }).first().locator('.edit').click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toBeVisible();
  // Agent messaging and agent workers are on the modal's Agents tab.
  await page.getByRole('tab', { name: /^Agents/ }).click();
  return page.locator('.modal.box-modal');
}

async function cancelModal(page: Page) {
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0);
}

async function boxIds(page: Page): Promise<Record<Label, string>> {
  const res = await page.request.get('/api/boxes');
  expect(res.ok()).toBeTruthy();
  const boxes = (await res.json()) as { id: string; label: string }[];
  const out = {} as Record<Label, string>;
  for (const label of LABELS) {
    const b = boxes.find((x) => x.label === label);
    expect(b, `seeded box ${label}`).toBeTruthy();
    out[label] = b!.id;
  }
  return out;
}

async function boxRecord(page: Page, id: string) {
  const res = await page.request.get('/api/boxes');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { id: string; user?: string }[]).find((b) => b.id === id)!;
}

async function putMail(page: Page, id: string, data: object) {
  const res = await page.request.put(`/api/boxes/${id}/mail`, { data });
  expect(res.status(), await res.text()).toBe(200);
}

async function mailView(page: Page, id: string) {
  const res = await page.request.get(`/api/boxes/${id}/mail`);
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function waitMailState(page: Page, id: string, state: string, timeout = 30000) {
  try {
    await expect.poll(async () => (await mailView(page, id)).status.state, { timeout, intervals: [250, 500, 1000] }).toBe(state);
  } catch (e) {
    throw new Error(`messaging status of ${id} never read ${state}: ${JSON.stringify((await mailView(page, id)).status)}\n${(e as Error).message}`);
  }
}

// Every box back to an empty policy, and every forward torn down. Used before and after each test.
async function resetMail(page: Page, ids: Record<Label, string>) {
  for (const label of LABELS) await putMail(page, ids[label], OFF);
  for (const label of LABELS) await waitMailState(page, ids[label], 'off');
}

// A session running an agent, as the server reads one: a pane that reads as `claude` (tmux's
// pane_current_command is argv[0]'s basename) and a five-field marker for that pane. `keep` is
// a session the fixture owns (the configured one: later specs attach to it), which goes back to
// a login shell instead of being killed. Returns the pane's id.
const agents = new Map<string, { pane: string; keep: boolean }>();
function startAgent(session: string, state: string, cause: string, keep = false): string {
  onBox(`tmux has-session -t '=${session}' 2>/dev/null || tmux new-session -d -s '${session}'`);
  onBox(`tmux respawn-pane -k -t '=${session}:' bash -c 'exec -a claude sleep 600'`);
  const pane = onBox(`tmux display-message -p -t '=${session}:' '#{pane_id}'`).trim();
  writePaneMarker(session, pane, state, now(), cause);
  agents.set(session, { pane, keep });
  return pane;
}

function stopAgent(session: string) {
  const a = agents.get(session);
  if (!a) return;
  agents.delete(session);
  fs.rmSync(path.join(markerDir(), `${session}${a.pane}`), { force: true });
  try {
    onBox(a.keep
      ? `tmux respawn-pane -k -t '=${session}:' "$(tmux show-options -gv default-shell)" -l`
      : `tmux kill-session -t '=${session}'`);
  } catch { /* gone */ }
}

// Until the server's own snapshot of `id` (what the mail hub reads: its pane marks) holds these
// sessions' states.
async function waitMarks(page: Page, id: string, want: Record<string, string>) {
  await expect.poll(async () => {
    const res = await page.request.get(`/api/status?box=${encodeURIComponent(id)}`);
    const marks: { session: string; state: string }[] = Object.values((await res.json())?.[id]?.paneMarks ?? {});
    return Object.fromEntries(Object.keys(want).map((s) => [s, marks.find((m) => m.session === s)?.state ?? null]));
  }, { timeout: 30000, intervals: [500, 1000] }).toEqual(want);
}

// POST /v1/threads through the box-side socket, as tmx does. Every value is a constant of this
// file (single-quoted into the box's login shell). Returns the HTTP code and the text answer.
function sendFromBox(session: string, to: string, body: string): { code: number; text: string } {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const cmd = `curl -s -m 10 -w '\\n%{http_code}' --unix-socket "$HOME/.tmuxifier-mail/sock" `
    + `--data-urlencode ${q(`session=${session}`)} --data-urlencode ${q(`to=${to}`)} --data-urlencode ${q(`body=${body}`)} `
    + 'http://mail/v1/threads';
  let out: string;
  try {
    out = execFileSync('ssh', ['-F', cfg, host, cmd], { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    const x = e as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string };
    throw new Error(`ssh to the box failed (exit ${x.status ?? 'none'}${x.signal ? `, ${x.signal}` : ''})\nstdout: ${x.stdout ?? ''}\nstderr: ${x.stderr ?? ''}`);
  }
  const cut = out.lastIndexOf('\n');
  return { code: Number(out.slice(cut + 1).trim()), text: out.slice(0, cut).replace(/\n$/, '') };
}

// Until the server has sampled `id` on `n` more status sweeps (2 s apart in e2e).
async function waitSweeps(page: Page, id: string, n: number) {
  const last = async () => {
    const series = (await (await page.request.get(`/api/health/series?box=${encodeURIComponent(id)}`)).json())?.[id] ?? [];
    return Number(series.at(-1)?.t) || 0;
  };
  const t0 = await last();
  await expect.poll(async () => (await last()) - t0, { timeout: 30000, intervals: [500, 1000] }).toBeGreaterThanOrEqual(n * 2000 - 500);
}

const textOf = (page: Page, selector: string) => page.locator(selector).first().evaluate((n) => n.textContent);

test('the Edit Box section saves a policy with its counterpart and shows the pair as complete', async ({ page }) => {
  await login(page);
  // Regression pin: the agentMail flag is read after every sign-in path, so right after the form
  // login above, with no reload, the Messages key and the modal section are both there.
  await expect(page.locator('#messages')).toBeVisible();
  const ids = await boxIds(page);
  // Saving the Edit Box modal also saves the box itself, and its User field shows `root` for a
  // box with no user (main.ts field('user', …, { value: 'root' })), so Save writes user: root
  // onto the seeded box. Later specs read the box's target as `tmuxifierlocal`, so the box record
  // is put back as it was.
  const boxBefore = await boxRecord(page, ids.localhost);
  try {
    await resetMail(page, ids);

    let modal = await openEditModal(page);
    let section = modal.locator('.box-mail');
    await expect(section).toBeVisible();
    await expect(section.locator('.mail-status')).toHaveText('Messaging is off', { timeout: 10000 });
    await expect(section.locator('.mail-pair')).toHaveCount(0);
    await expect(section.getByLabel('When adding a box, also write the matching entry on that box')).toBeChecked();

    await section.getByLabel('Agents here may send').check();
    await section.getByLabel('Add a box to the send list').selectOption({ label: 'db-primary' });
    await expect(section.getByRole('button', { name: 'Remove db-primary from the send list' })).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('heading', { name: 'Edit box' })).toHaveCount(0, { timeout: 10000 });

    // Saved: this box's send switch and list, and the counterpart on db-primary (its receive
    // list, never its switch).
    expect((await mailView(page, ids.localhost)).policy).toEqual({ send: true, sendTo: [ids['db-primary']], receive: false, receiveFrom: [] });
    expect((await mailView(page, ids['db-primary'])).policy).toEqual({ send: false, sendTo: [], receive: false, receiveFrom: [ids.localhost] });

    modal = await openEditModal(page);
    section = modal.locator('.box-mail');
    await expect(section.getByRole('button', { name: 'Remove db-primary from the send list' })).toBeVisible({ timeout: 10000 });
    await expect(section.getByLabel('Agents here may send')).toBeChecked();
    await expect.poll(() => textOf(page, '.box-mail .mail-pair')).toBe("db-primary   send: waiting, db-primary's receive switch is off");
    await cancelModal(page);

    await putMail(page, ids['db-primary'], { send: false, sendTo: [], receive: true, receiveFrom: [ids.localhost] });
    modal = await openEditModal(page);
    await expect(modal.locator('.box-mail .mail-pair')).toHaveCount(1, { timeout: 10000 });
    await expect.poll(() => textOf(page, '.box-mail .mail-pair')).toBe('db-primary   send ✓');
    await cancelModal(page);
  } finally {
    // The box record first: a resetMail timeout must not leave user: root on the seeded box.
    try {
      await page.request.patch(`/api/boxes/${ids.localhost}`, { data: { user: boxBefore.user ?? null } });
      expect(await boxRecord(page, ids.localhost)).toEqual(boxBefore);
    } finally {
      await resetMail(page, ids);
    }
  }
});

test('a message sent from the box appears in the Messages drawer, and Stop closes the thread', async ({ page }) => {
  test.setTimeout(150000);
  await login(page);
  const ids = await boxIds(page);
  let threadId: string | null = null;
  try {
    await resetMail(page, ids);
    // mailA is the caller, idle; the box's configured session (what a bare `localhost` names)
    // is the target, mid-turn, so the message stays queued and the row says why.
    startAgent('mailA', 'ready', 'stop');
    startAgent(boxSession, 'working', 'prompt', true);
    await waitMarks(page, ids.localhost, { mailA: 'ready', [boxSession]: 'working' });

    // One box entry switched on, so its forward is the only one and owns the socket (header).
    await putMail(page, ids.localhost, { send: true, sendTo: [], receive: true, receiveFrom: [] });
    await waitMailState(page, ids.localhost, 'up');
    // The modal's last line reads the live forward (the fixture home may or may not have tmx,
    // depending on whether a setup spec ran first; nothing waits on the box yet).
    const modal = await openEditModal(page);
    await expect(modal.locator('.box-mail .mail-status'))
      .toHaveText(/^(Tools not installed: run setup on this box|Tools installed · socket connected · no sessions listening)$/, { timeout: 10000 });
    await cancelModal(page);

    const sent = sendFromBox('mailA', 'localhost', 'ping');
    expect(sent.code, sent.text).toBe(200);
    threadId = /Thread (t-[a-z2-9]{8})\./.exec(sent.text)?.[1] ?? null;
    expect(threadId, sent.text).toBeTruthy();
    const api = await (await page.request.get(`/api/mail/threads/${threadId}`)).json();
    expect(api.thread.starter).toEqual({ boxId: ids.localhost, session: 'mailA' });
    expect(api.thread.peer).toEqual({ boxId: ids.localhost, session: boxSession });

    await page.locator('#messages').click();
    const panel = page.locator('#messages-panel');
    await expect(panel).toHaveClass(/\bopen\b/);
    await expect(page.locator('#messages')).toHaveClass(/\bactive\b/);
    await expect(panel.locator('#messages-tab-threads')).toHaveAttribute('aria-selected', 'true');
    const row = panel.locator(`button.mail-thread-row[data-id="${threadId}"]`);
    await expect(row).toBeVisible({ timeout: 10000 });
    await expect(row.locator('.mail-thread-title')).toHaveText(`localhost/mailA → localhost/${boxSession}`);
    await expect(row.locator('.mail-thread-state')).toHaveText('open');
    await expect(row.locator('.mail-thread-status')).toHaveText(`waiting: localhost/${boxSession} is working`);

    await row.click();
    const view = panel.locator(`.mail-thread[data-id="${threadId}"]`);
    await expect(view).toBeVisible();
    await expect(view.locator('.mail-thread-head .mail-thread-title')).toHaveText(`localhost/mailA → localhost/${boxSession}`);
    await expect(view.locator('li.mail-msg')).toHaveCount(1);
    await expect(view.locator('pre.mail-msg-body')).toHaveText('ping');
    await expect(view.locator('.mail-msg-who')).toHaveText('localhost/mailA');
    await expect(view.locator('.mail-msg-state')).toHaveText('waiting');

    const stop = view.locator('button.mail-stop');
    await expect(stop).toHaveText('Stop');
    await stop.click();
    await expect(stop).toHaveText('Confirm');
    await expect(stop).toHaveClass(/\barmed\b/);
    await stop.click();
    await expect(view.locator('.mail-thread-head .mail-thread-state')).toHaveText('closed by you', { timeout: 10000 });
    await expect(stop).toBeHidden();
    await expect(view.locator('.mail-msg-state')).toHaveText('dropped');

    await view.locator('button.mail-back').click();
    await expect(row.locator('.mail-thread-state')).toHaveText('closed by you', { timeout: 10000 });
    await expect(row.locator('.mail-thread-status')).toHaveText('closed by the operator');

    const after = await (await page.request.get(`/api/mail/threads/${threadId}`)).json();
    expect(after.thread).toMatchObject({ state: 'closed', reason: 'operator' });
    expect(after.thread.messages.map((m: { state: string }) => m.state)).toEqual(['dropped']);
  } finally {
    if (threadId) await page.request.post(`/api/mail/threads/${threadId}/close`).catch(() => {});
    stopAgent('mailA');
    stopAgent(boxSession);
    await resetMail(page, ids);
  }
});

test('a refused send shows under Refused', async ({ page }) => {
  test.setTimeout(120000);
  await login(page);
  const ids = await boxIds(page);
  // A session of its own, so its refusal is told apart from any earlier run's in the log.
  const session = `mailr-${randomBytes(3).toString('hex')}`;
  const reason = 'refused: this box is not allowed to send to untagged-worker';
  try {
    await resetMail(page, ids);
    startAgent(session, 'ready', 'stop');
    await waitMarks(page, ids.localhost, { [session]: 'ready' });
    // Only the sender is on, so its forward is the only one: send allowed, to nobody.
    await putMail(page, ids.localhost, { send: true, sendTo: [], receive: false, receiveFrom: [] });
    await waitMailState(page, ids.localhost, 'up');

    const sent = sendFromBox(session, 'untagged-worker', 'ping');
    expect(sent.code, sent.text).toBe(403);
    expect(sent.text).toBe(reason);

    await page.locator('#messages').click();
    const panel = page.locator('#messages-panel');
    await expect(panel).toHaveClass(/\bopen\b/);
    await panel.locator('#messages-tab-refused').click();
    await expect(panel.locator('#messages-tab-refused')).toHaveAttribute('aria-selected', 'true');
    const item = panel.locator('li.mail-refusal', { has: page.locator('.mail-refusal-who', { hasText: `localhost/${session}` }) });
    await expect(item).toHaveCount(1, { timeout: 10000 });
    await expect(item.locator('.mail-refusal-target')).toHaveText('untagged-worker');
    await expect(item.locator('.mail-refusal-reason')).toHaveText(reason);
    // Newest first: it heads the list.
    await expect(panel.locator('li.mail-refusal').first().locator('.mail-refusal-who')).toHaveText(`localhost/${session}`);
  } finally {
    stopAgent(session);
    await resetMail(page, ids);
  }
});

test('with messaging off on a box the modal says "Messaging is off" and the drawer still opens', async ({ page }) => {
  await login(page);
  const ids = await boxIds(page);
  try {
    await resetMail(page, ids);
    const modal = await openEditModal(page);
    const section = modal.locator('.box-mail');
    await expect(section.locator('.mail-status')).toHaveText('Messaging is off', { timeout: 10000 });
    await expect(section.getByLabel('Agents here may send')).not.toBeChecked();
    await expect(section.getByLabel('Agents here may receive')).not.toBeChecked();
    await expect(section.locator('.mail-pair')).toHaveCount(0);
    await cancelModal(page);

    await page.locator('#messages').click();
    const panel = page.locator('#messages-panel');
    await expect(panel).toHaveClass(/\bopen\b/);
    await expect(panel.locator('#messages-tab-threads')).toHaveAttribute('aria-selected', 'true');
    // Loaded: earlier tests' closed threads, or the empty state when this file runs alone.
    await expect.poll(() => panel.locator('.messages-content').evaluate((n) => (n.querySelector('ul.mail-threads') ? 'list' : n.textContent)), { timeout: 10000 })
      .toMatch(/^(list|No messages yet\.)$/);
    await expect(panel.locator('.messages-error')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(panel).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('#messages')).not.toHaveClass(/\bactive\b/);
  } finally {
    await resetMail(page, ids);
  }
});

test('two box entries on one machine: the second reads that it shares a connection, and the first one\'s socket still works', async ({ page }) => {
  test.setTimeout(150000);
  await login(page);
  const ids = await boxIds(page);
  let threadId: string | null = null;
  try {
    await resetMail(page, ids);
    startAgent('mailA', 'ready', 'stop');
    startAgent(boxSession, 'working', 'prompt', true);
    await waitMarks(page, ids.localhost, { mailA: 'ready', [boxSession]: 'working' });

    // localhost first: it holds the shared ssh master's forward.
    await putMail(page, ids.localhost, { send: true, sendTo: [], receive: true, receiveFrom: [] });
    await waitMailState(page, ids.localhost, 'up');
    // Then db-primary, an ssh alias of the same machine: refused, naming the holder.
    await putMail(page, ids['db-primary'], { send: false, sendTo: [], receive: true, receiveFrom: [ids.localhost] });
    await waitMailState(page, ids['db-primary'], 'error');
    expect((await mailView(page, ids['db-primary'])).status.error).toBe('shares a connection with localhost');

    const modal = await openEditModal(page, 'db-primary');
    await expect(modal.locator('.box-mail .mail-status')).toHaveText('Socket not connected: shares a connection with localhost', { timeout: 10000 });
    await cancelModal(page);
    // The holder is untouched.
    expect((await mailView(page, ids.localhost)).status.state).toBe('up');

    const sent = sendFromBox('mailA', 'localhost', 'ping');
    expect(sent.code, sent.text).toBe(200);
    threadId = /Thread (t-[a-z2-9]{8})\./.exec(sent.text)?.[1] ?? null;
    expect(threadId, sent.text).toBeTruthy();
    const api = await (await page.request.get(`/api/mail/threads/${threadId}`)).json();
    expect(api.thread.starter).toEqual({ boxId: ids.localhost, session: 'mailA' });
    // Three more sweeps (each runs the forward keeper): still refused, and the socket still the
    // holder's. A second thread is closed in finally too.
    await page.request.post(`/api/mail/threads/${threadId}/close`);
    await waitSweeps(page, ids.localhost, 3);
    expect((await mailView(page, ids['db-primary'])).status).toMatchObject({ state: 'error', error: 'shares a connection with localhost' });
    expect((await mailView(page, ids.localhost)).status.state).toBe('up');
    const again = sendFromBox('mailA', 'localhost', 'ping again');
    expect(again.code, again.text).toBe(200);
    threadId = /Thread (t-[a-z2-9]{8})\./.exec(again.text)?.[1] ?? null;
    expect((await (await page.request.get(`/api/mail/threads/${threadId}`)).json()).thread.starter).toEqual({ boxId: ids.localhost, session: 'mailA' });
  } finally {
    if (threadId) await page.request.post(`/api/mail/threads/${threadId}/close`).catch(() => {});
    stopAgent('mailA');
    stopAgent(boxSession);
    await resetMail(page, ids);
  }
});
