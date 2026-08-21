import { test, expect, afterEach } from 'vitest';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import {
  createBoxActions,
  buildEnsureSessionRemote,
  buildKillSessionRemote,
  buildKillWindowRemote,
} from '../src/server/boxActions.js';

// The kill remotes run over real ssh against the isolated sshd/tmux fixture,
// under the box's login shell. The '=' exact-match rule is the whole point of
// this file: a fake transport would report these green while a bare -t target
// silently killed the wrong session.

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });

async function harness() {
  const lb = await setupLocalBox();
  teardown = lb.cleanup;
  const box = { id: 'b1', label: 'local', host: lb.box.host, sessionName: lb.session };
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    sshConfigFile: lb.sshConfigFile,
  });
  return { box, boxActions };
}

const listSessions = (boxActions, box) =>
  boxActions.execCommand(box, "tmux list-sessions -F '#{session_name}'", { timeoutMs: 12000 });

test('killing a session leaves a longer-named neighbour alone (exact-match guard)', async () => {
  // THE test. A bare `kill-session -t web` prefix-matches when no exact 'web'
  // exists — and even when it does exist, this asserts the neighbour survives.
  // Getting this wrong destroys a stranger's session with no way back.
  const { box, boxActions } = await harness();
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('web', null), { timeoutMs: 20000 })).code).toBe(0);
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('web2', null), { timeoutMs: 20000 })).code).toBe(0);

  const killed = await boxActions.execCommand(box, buildKillSessionRemote('web'), { timeoutMs: 15000 });
  expect(killed.code).toBe(0);

  const ls = await listSessions(boxActions, box);
  expect(ls.stdout).toContain('web2');
  expect(ls.stdout.split(/\r?\n/).map((s) => s.trim())).not.toContain('web');
});

test('killing a window removes only that window and leaves the session running', async () => {
  const { box, boxActions } = await harness();
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('multi', null), { timeoutMs: 20000 })).code).toBe(0);
  await boxActions.execCommand(box, "tmux new-window -t '=multi' -n second", { timeoutMs: 12000 });

  const before = await boxActions.execCommand(box, "tmux list-windows -t '=multi' -F '#{window_id} #{window_name}'", { timeoutMs: 12000 });
  const secondId = before.stdout.split(/\r?\n/).find((l) => l.includes('second'))?.split(' ')[0];
  expect(secondId).toMatch(/^@\d+$/);

  const killed = await boxActions.execCommand(box, buildKillWindowRemote('multi', secondId), { timeoutMs: 15000 });
  expect(killed.code).toBe(0);

  const after = await boxActions.execCommand(box, "tmux list-windows -t '=multi' -F '#{window_name}'", { timeoutMs: 12000 });
  expect(after.stdout).not.toContain('second');
  expect((await listSessions(boxActions, box)).stdout).toContain('multi');
});

test('killing a session that does not exist reports failure rather than silent success', async () => {
  // buildKillTmuxRemote ends in `|| true` and would pass this while doing
  // nothing. The route turns this non-zero exit into a 502.
  const { box, boxActions } = await harness();
  const res = await boxActions.execCommand(box, buildKillSessionRemote('never-existed'), { timeoutMs: 15000 });
  expect(res.code).not.toBe(0);
});
