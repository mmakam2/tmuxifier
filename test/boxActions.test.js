import { test, expect } from 'vitest';
import { buildEnsureTmuxRemote, buildKillTmuxRemote, createBoxActions } from '../src/server/boxActions.js';

test('buildEnsureTmuxRemote installs tmux when missing and creates the session', () => {
  const remote = buildEnsureTmuxRemote('web', "echo 'hi'");
  expect(remote).toContain('command -v tmux');
  expect(remote).toContain('apt-get install -y tmux');
  expect(remote).toContain('apt-get update || true');
  expect(remote).toContain('dnf install -y tmux');
  expect(remote).toContain("tmux has-session -t 'web'");
  expect(remote).toContain("tmux new-session -d -s 'web' 'echo '\\''hi'\\'''");
});

test('buildKillTmuxRemote ignores absent tmux sessions', () => {
  expect(buildKillTmuxRemote('we b')).toBe(
    "if command -v tmux >/dev/null 2>&1; then tmux kill-session -t 'we-b' 2>/dev/null || true; fi",
  );
});

test('ensureReady throws useful remote output on failure', async () => {
  const actions = createBoxActions({
    run: async () => ({ code: 1, stdout: '', stderr: 'sudo password required' }),
  });

  await expect(actions.ensureReady({ host: 'h', sessionName: 'web' })).rejects.toThrow(/sudo password required/);
});

test('killSession is best effort', async () => {
  const actions = createBoxActions({
    run: async () => { throw new Error('offline'); },
  });

  await expect(actions.killSession({ host: 'h', sessionName: 'web' })).resolves.toEqual({ ok: true });
});
