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

test('killing a session removes exactly that session, leaving another running session alone', async () => {
  // NOT the exact-match guard: with 'web' itself present, tmux resolves a bare
  // `-t web` to the exact name FIRST (verified on real tmux 3.5a — prefix
  // matching only kicks in when no exact match exists), so this passes
  // identically whether buildKillSessionRemote emits '=web' or a bare 'web'.
  // It only proves the ordinary case works. See the next test for the actual
  // exact-match guard, which requires the exact name to be ABSENT.
  const { box, boxActions } = await harness();
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('web', null), { timeoutMs: 20000 })).code).toBe(0);
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('web2', null), { timeoutMs: 20000 })).code).toBe(0);

  const killed = await boxActions.execCommand(box, buildKillSessionRemote('web'), { timeoutMs: 15000 });
  expect(killed.code).toBe(0);

  const ls = await listSessions(boxActions, box);
  expect(ls.stdout).toContain('web2');
  expect(ls.stdout.split(/\r?\n/).map((s) => s.trim())).not.toContain('web');
});

test('killing an absent session does not prefix-match a longer-named neighbour (exact-match guard)', async () => {
  // THE exact-match guard, mirroring sessionCreate.integration.test.js's own
  // "a longer-named session does not swallow the create" test: create ONLY
  // the longer name, then target the SHORTER name that does not exist. A bare
  // `kill-session -t web` with only 'web2' present prefix-matches and kills
  // web2 with exit 0 — verified on real tmux 3.5a. Only the '=' target fails
  // with "can't find session: web" and leaves web2 untouched.
  const { box, boxActions } = await harness();
  expect((await boxActions.execCommand(box, buildEnsureSessionRemote('web2', null), { timeoutMs: 20000 })).code).toBe(0);

  const killed = await boxActions.execCommand(box, buildKillSessionRemote('web'), { timeoutMs: 15000 });
  expect(killed.code).not.toBe(0);

  const ls = await listSessions(boxActions, box);
  expect(ls.stdout).toContain('web2');
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
