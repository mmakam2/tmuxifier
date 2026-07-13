import { test, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { createBoxActions } from '../src/server/boxActions.js';

let teardown;
const sessions = [];
let lb;
afterEach(async () => {
  for (const s of sessions.splice(0)) {
    try { await sshRun(['-F', lb.sshConfigFile, lb.box.host, `tmux kill-session -t ${s} 2>/dev/null || true`], { env: lb.env }); } catch {}
  }
  if (teardown) await teardown();
  teardown = null;
});

async function harness() {
  lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: 'ignored' };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  return { box, boxActions };
}

async function newSession(cmd) {
  const s = `tmuxinj-${randomUUID().slice(0, 8)}`;
  sessions.push(s);
  await sshRun(['-F', lb.sshConfigFile, lb.box.host, `tmux new-session -d -s ${s}${cmd ? ` '${cmd}'` : ''}`], { env: lb.env });
  return s;
}

async function capture(s) {
  const r = await sshRun(['-F', lb.sshConfigFile, lb.box.host, `tmux capture-pane -p -t ${s}`], { env: lb.env });
  return String(r.stdout || '');
}

test('injects the quoted path into a real shell pane', async () => {
  const { box, boxActions } = await harness();
  const s = await newSession(); // default shell → prompt
  // wait for the shell prompt to draw (poll up to ~6s)
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 200));
    ready = /[$%#❯>] ?\s*$/.test((await capture(s)).trimEnd());
  }
  const res = await boxActions.injectUploadPath(box, s, '/tmp/tmuxinj-fake.png');
  expect(res.injected).toBe(true);
  expect(res.mode).toBe('shell');
  expect(await capture(s)).toContain("'/tmp/tmuxinj-fake.png'");
});

test('does not type into a busy pane', async () => {
  const { box, boxActions } = await harness();
  const s = await newSession('cat'); // cat waits on stdin, blank pane → busy
  await new Promise((r) => setTimeout(r, 400));
  const res = await boxActions.injectUploadPath(box, s, '/tmp/tmuxinj-fake2.png');
  expect(res).toEqual({ injected: false, mode: 'busy' });
  expect(await capture(s)).not.toContain('tmuxinj-fake2.png');
});

test('missing session degrades to busy, never throws', async () => {
  const { box, boxActions } = await harness();
  const res = await boxActions.injectUploadPath(box, 'tmuxinj-nonexistent', '/tmp/x.png');
  expect(res.injected).toBe(false);
  expect(['busy', 'error']).toContain(res.mode);
});
