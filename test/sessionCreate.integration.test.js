import { test, expect, afterEach } from 'vitest';
import { setupLocalBox } from './helpers/localBox.js';
import { sshRun } from '../src/server/sshRun.js';
import { createBoxActions, buildEnsureSessionRemote } from '../src/server/boxActions.js';

// The create-session route runs buildEnsureSessionRemote over real ssh against
// the isolated sshd/tmux fixture. The remote executes under the box's login
// shell (not the sh the unit tests imply), so a green fake-transport suite
// proves nothing about it — this is the real-transport check.

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

test('creates a real detached session the box then lists, idempotently', async () => {
  const { box, boxActions } = await harness();
  const remote = buildEnsureSessionRemote('created-by-test', 'sleep 30');
  const first = await boxActions.execCommand(box, remote, { timeoutMs: 20000 });
  expect(first.code).toBe(0);
  const has = await boxActions.execCommand(box, "tmux has-session -t '=created-by-test'", { timeoutMs: 12000 });
  expect(has.code).toBe(0);
  // Second create is a no-op, not an error (the has-session guard).
  const second = await boxActions.execCommand(box, remote, { timeoutMs: 20000 });
  expect(second.code).toBe(0);
  // Created detached: the box's own configured session is untouched and the
  // new one really runs the startup command.
  const ls = await boxActions.execCommand(box, "tmux list-sessions -F '#{session_name}'", { timeoutMs: 12000 });
  expect(ls.stdout).toContain('created-by-test');
  const cmd = await boxActions.execCommand(box, "tmux list-panes -t '=created-by-test' -F '#{pane_current_command}'", { timeoutMs: 12000 });
  expect(cmd.stdout.trim()).toBe('sleep');
});

test('a longer-named session does not swallow the create (exact-match guard)', async () => {
  // tmux -t falls back to prefix matching when no exact name exists, so with
  // only 'alpha-long' present a bare `has-session -t alpha` succeeds and the
  // guard skips creating 'alpha' — the route reports ok for a session that was
  // never made. The '=' target forces the exact match.
  const { box, boxActions } = await harness();
  const long = await boxActions.execCommand(box, buildEnsureSessionRemote('alpha-long', null), { timeoutMs: 20000 });
  expect(long.code).toBe(0);
  const short = await boxActions.execCommand(box, buildEnsureSessionRemote('alpha', null), { timeoutMs: 20000 });
  expect(short.code).toBe(0);
  const has = await boxActions.execCommand(box, "tmux has-session -t '=alpha'", { timeoutMs: 12000 });
  expect(has.code).toBe(0);
});
