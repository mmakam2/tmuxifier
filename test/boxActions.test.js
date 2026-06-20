import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEnsureTmuxRemote, buildKillTmuxRemote, createBoxActions } from '../src/server/boxActions.js';

function runShell(script, env) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { env: { ...process.env, ...env }, timeout: 5000 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

test('buildEnsureTmuxRemote installs tmux when missing and creates the session', () => {
  const remote = buildEnsureTmuxRemote('web', "echo 'hi'");
  expect(remote).toContain('command -v tmux');
  expect(remote).toContain('apt-get install -y tmux');
  expect(remote).toContain('apt-get update || true');
  expect(remote).toContain('dnf install -y tmux');
  expect(remote).toContain("\"$TMUX_BIN\" has-session -t 'web'");
  expect(remote).toContain("\"$TMUX_BIN\" new-session -d -s 'web' 'echo '\\''hi'\\'''");
});

test('buildEnsureTmuxRemote skips package managers when tmux is already installed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-actions-'));
  const tmuxLog = path.join(dir, 'tmux.log');
  const aptLog = path.join(dir, 'apt.log');
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_TMUX_LOG"\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'apt-get'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_APT_LOG"\nexit 88\n', { mode: 0o755 });

  const res = await runShell(buildEnsureTmuxRemote('web'), {
    PATH: dir,
    TMUXIFIER_TMUX_LOG: tmuxLog,
    TMUXIFIER_APT_LOG: aptLog,
  });

  expect(res.code).toBe(0);
  await expect(fs.readFile(tmuxLog, 'utf8')).resolves.toContain('has-session -t web');
  await expect(fs.stat(aptLog)).rejects.toMatchObject({ code: 'ENOENT' });
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
