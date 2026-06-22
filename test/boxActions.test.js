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
  expect(remote).toContain("sed -i 's/^set -g mouse on/set -g mouse off/' .tmux.conf.local");
});

test('buildEnsureTmuxRemote skips package managers when tmux is already installed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-actions-'));
  const tmuxLog = path.join(dir, 'tmux.log');
  const aptLog = path.join(dir, 'apt.log');
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_TMUX_LOG"\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'apt-get'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_APT_LOG"\nexit 88\n', { mode: 0o755 });

  await fs.writeFile(path.join(dir, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

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
  expect(remote).toContain('</dev/null');
  expect(remote).toContain('ZSH_THEME="blinks"');
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
  await fs.writeFile(path.join(dir, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
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

test('buildEnsureTmuxRemote includes Oh My Bash install steps when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { installOhMyBash: true });

  // Detects bash binary
  expect(remote).toContain('command -v bash');

  // Fetches upstream Oh My Bash install script
  expect(remote).toContain('https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh');
  expect(remote).toContain('OMB="$(curl');
  expect(remote).toContain('</dev/null');

  // Runs chsh to set default shell to bash (mirrors OMZ pattern)
  expect(remote).toContain('chsh -s "$BASH_BIN"');

  // Sets tmux default-shell to bash and respawns
  expect(remote).toContain('default-shell');
  expect(remote).toContain('BASH_BIN');
});

test('buildEnsureTmuxRemote omits Oh My Bash steps when not requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, {});
  expect(remote).not.toContain('command -v bash');
  expect(remote).not.toContain('https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh');
  // BASH_BIN appears in the unconditional default-shell line (same pattern as ZSH_BIN), so we don't assert its absence
});

test('buildEnsureTmuxRemote skips Oh My Bash clone when .oh-my-bash exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-oh-my-bash-'));
  await fs.mkdir(path.join(dir, '.oh-my-bash'));
  await fs.writeFile(path.join(dir, 'bash'), '#!/bin/sh\necho "$*" >> "$TMUXIFIER_BASH_LOG"\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'curl'), '#!/bin/sh\necho curled >> "$TMUXIFIER_CURL_LOG"\nexit 0\n', { mode: 0o755 });
  const curlLog = path.join(dir, 'curl.log');

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyBash: true })}`, {
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
    HOME: dir,
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

test('killSession is best effort', async () => {
  const actions = createBoxActions({
    run: async () => { throw new Error('offline'); },
  });

  await expect(actions.killSession({ host: 'h', sessionName: 'web' })).resolves.toEqual({ ok: true });
});

test('exitMaster runs ssh -O exit over the box control path', async () => {
  const calls = [];
  const actions = createBoxActions({
    run: async (argv) => { calls.push(argv); return { code: 0, stdout: 'Exit request sent.', stderr: '' }; },
    controlDir: '/run/cm',
  });
  await actions.exitMaster({ host: 'h', user: 'me' });
  const exitCall = calls.find((a) => a.includes('-O') && a.includes('exit'));
  expect(exitCall).toBeTruthy();
  expect(exitCall).toContain('ControlPath=/run/cm/%C');
});

test('exitMaster force-removes the orphan socket a dead master left behind', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-cm-'));
  const socket = path.join(dir, 'deadbeef');
  await fs.writeFile(socket, ''); // stand-in for the orphaned master socket
  const actions = createBoxActions({
    run: async (argv) => {
      if (argv.includes('-G')) return { code: 0, stdout: `controlpath ${socket}\n`, stderr: '' };
      // `ssh -O exit` against a dead master fails and leaves the socket behind.
      return { code: 255, stdout: '', stderr: 'Control socket connect: No such file or directory' };
    },
    controlDir: dir,
  });
  await actions.exitMaster({ host: 'h', user: 'me' });
  await expect(fs.stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('reapStaleMaster removes an orphaned socket when no live master is running', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-cm-'));
  const socket = path.join(dir, 'orphan');
  await fs.writeFile(socket, '');
  const actions = createBoxActions({
    run: async (argv) => {
      if (argv.includes('check')) return { code: 255, stdout: '', stderr: 'Control socket connect: Connection refused' };
      if (argv.includes('-G')) return { code: 0, stdout: `controlpath ${socket}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    controlDir: dir,
  });
  const res = await actions.reapStaleMaster({ host: 'h', user: 'me' });
  expect(res.reaped).toBe(true);
  await expect(fs.stat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('reapStaleMaster leaves a healthy live master untouched', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-cm-'));
  const socket = path.join(dir, 'live');
  await fs.writeFile(socket, '');
  let resolvedPath = false;
  const actions = createBoxActions({
    run: async (argv) => {
      if (argv.includes('check')) return { code: 0, stdout: 'Master running (pid=123)', stderr: '' };
      if (argv.includes('-G')) { resolvedPath = true; return { code: 0, stdout: `controlpath ${socket}\n` }; }
      return { code: 0, stdout: '', stderr: '' };
    },
    controlDir: dir,
  });
  const res = await actions.reapStaleMaster({ host: 'h', user: 'me' });
  expect(res.reaped).toBe(false);
  expect(resolvedPath).toBe(false); // never even resolves/unlinks a live master
  await expect(fs.stat(socket)).resolves.toBeTruthy();
});

test('reapStaleMaster is a no-op when multiplexing is disabled', async () => {
  let called = false;
  const actions = createBoxActions({ run: async () => { called = true; return { code: 0 }; } });
  const res = await actions.reapStaleMaster({ host: 'h' });
  expect(called).toBe(false);
  expect(res).toEqual({ ok: true, reaped: false });
});

test('exitMaster is a no-op when multiplexing is disabled', async () => {
  let called = false;
  const actions = createBoxActions({ run: async () => { called = true; return { code: 0 }; } });
  const res = await actions.exitMaster({ host: 'h' });
  expect(called).toBe(false);
  expect(res).toEqual({ ok: true });
});

test('exitMaster is best effort (swallows ssh errors)', async () => {
  const actions = createBoxActions({
    run: async () => { throw new Error('no master'); },
    controlDir: '/run/cm',
  });
  await expect(actions.exitMaster({ host: 'h' })).resolves.toEqual({ ok: true });
});
