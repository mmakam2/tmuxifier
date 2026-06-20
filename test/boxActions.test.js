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
  expect(remote).toContain('apt-get install -y --no-install-recommends tmux');
  expect(remote).toContain('apt-get update || true');
  expect(remote).toContain('dnf install -y tmux');
  expect(remote).toContain("\"$TMUX_BIN\" has-session -t 'web'");
  expect(remote).toContain("\"$TMUX_BIN\" new-session -d -s 'web' 'echo '\\''hi'\\'''");
});

test('buildEnsureTmuxRemote includes Oh My Tmux manual install steps when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { installOhMyTmux: true });

  expect(remote).toContain('https://github.com/gpakosz/.tmux.git');
  expect(remote).toContain('git clone --single-branch https://github.com/gpakosz/.tmux.git .tmux');
  expect(remote).toContain('ln -s -f .tmux/.tmux.conf .tmux.conf');
  expect(remote).toContain('cp .tmux/.tmux.conf.local .tmux.conf.local');
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

test('buildEnsureTmuxRemote includes zsh and Oh My Zsh install steps when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { installOhMyZsh: true });

  // Installs zsh via package manager detection
  expect(remote).toContain('command -v zsh');
  expect(remote).toContain('apt-get install -y --no-install-recommends zsh');
  expect(remote).toContain('dnf install -y zsh');

  // Fetches upstream Oh My Zsh install script
  expect(remote).toContain('https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh');
  expect(remote).toContain('OHMYZSH="$(curl');
  expect(remote).toContain('RUNZSH=no');
  expect(remote).toContain('CHSH=yes');
  expect(remote).toContain('chsh -s "$ZSH_BIN"');
  expect(remote).toContain('default-shell');
});

test('buildEnsureTmuxRemote omits Oh My Zsh steps when not requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, {});
  expect(remote).not.toContain('command -v zsh');
  expect(remote).not.toContain('https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh');
  expect(remote).not.toContain('RUNZSH=no');
});

test('buildEnsureTmuxRemote skips Oh My Zsh clone when .oh-my-zsh exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oh-my-zsh-'));
  await fs.mkdir(path.join(dir, '.oh-my-zsh'));
  await fs.writeFile(path.join(dir, 'zsh'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_ZSH_LOG"\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'curl'), '#!/bin/sh\necho curled >> "$TMUXIFIER_CURL_LOG"\nexit 0\n', { mode: 0o755 });
  const curlLog = path.join(dir, 'curl.log');

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyZsh: true })}`, {
    PATH: dir,
    TMUXIFIER_CURL_LOG: curlLog,
  });

  expect(res.code).toBe(0);
  await expect(fs.stat(curlLog)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('buildEnsureTmuxRemote skips Oh My Tmux clone when config exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oh-my-tmux-'));
  await fs.mkdir(path.join(dir, '.tmux'));
  await fs.writeFile(path.join(dir, '.tmux', '.tmux.conf'), '# existing\n');
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'git'), '#!/bin/sh\necho cloned > "$TMUXIFIER_GIT_LOG"\nexit 0\n', { mode: 0o755 });
  const gitLog = path.join(dir, 'git.log');

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyTmux: true })}`, {
    PATH: dir,
    TMUXIFIER_GIT_LOG: gitLog,
  });

  expect(res.code).toBe(0);
  await expect(fs.stat(gitLog)).rejects.toMatchObject({ code: 'ENOENT' });
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
