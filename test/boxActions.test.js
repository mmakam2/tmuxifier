import { test, expect } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEnsureTmuxRemote, buildKillTmuxRemote, createBoxActions, resolveTools, TOOL_IDS } from '../src/server/boxActions.js';

function runShell(script, env) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', script], { env: { ...process.env, ...env }, timeout: 5000 }, (err, stdout, stderr) => {
      resolve({ code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout, stderr });
    });
  });
}

// Syntax-check a script without executing it (`sh -n <file>`): catches quoting /
// unbalanced-block regressions in the generated setup script.
async function syntaxCheck(script) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-syntax-'));
  const file = path.join(dir, 'setup.sh');
  await fs.writeFile(file, script);
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-n', file], { timeout: 5000 }, (err, stdout, stderr) => {
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

test('buildEnsureTmuxRemote installs tmux before the optional tools', () => {
  // tmux is the one thing the terminal needs; the tools (esp. `upgrade`) are
  // slow and failure-prone under `set -eu`. Installing tmux first means a tool
  // failure or a mid-run interruption still leaves a terminal-usable box.
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['upgrade', 'node'] });
  const tmuxIdx = remote.indexOf('--no-install-recommends tmux');
  const upgradeIdx = remote.indexOf('apt-get -y upgrade'); // the `upgrade` tool block
  expect(tmuxIdx).toBeGreaterThan(-1);
  expect(upgradeIdx).toBeGreaterThan(-1);
  expect(tmuxIdx).toBeLessThan(upgradeIdx);
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

test('isMasterAlive is true when -O check reports a running master', async () => {
  const actions = createBoxActions({
    run: async (argv) => (argv.includes('check') ? { code: 0, stdout: 'Master running', stderr: '' } : { code: 0 }),
    controlDir: '/run/cm',
  });
  expect(await actions.isMasterAlive({ host: 'h', user: 'me' })).toBe(true);
});

test('isMasterAlive is false when no master is listening', async () => {
  const actions = createBoxActions({
    run: async (argv) => (argv.includes('check') ? { code: 255, stdout: '', stderr: 'Control socket connect: No such file' } : { code: 0 }),
    controlDir: '/run/cm',
  });
  expect(await actions.isMasterAlive({ host: 'h', user: 'me' })).toBe(false);
});

test('isMasterAlive is false when multiplexing is disabled (no control dir)', async () => {
  let called = false;
  const actions = createBoxActions({ run: async () => { called = true; return { code: 0 }; } });
  expect(await actions.isMasterAlive({ host: 'h' })).toBe(false);
  expect(called).toBe(false);
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

test('execCommand runs the command verbatim as the final ssh arg, capturing output', async () => {
  let argv;
  const actions = createBoxActions({
    run: async (a) => { argv = a; return { code: 0, stdout: 'hi\n', stderr: '' }; },
    controlDir: '/run/cm',
  });
  const res = await actions.execCommand({ host: 'h', user: 'me' }, 'df -h /', { timeoutMs: 1000 });
  expect(res).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
  expect(argv[argv.length - 1]).toBe('df -h /'); // command is the last argv element, verbatim (NOT quoted)
  expect(argv).toContain('me@h');
  expect(argv).toContain('BatchMode=yes');
});

test('execCommand rejects an unsafe box before running ssh', async () => {
  let called = false;
  const actions = createBoxActions({ run: async () => { called = true; return { code: 0 }; } });
  await expect(actions.execCommand({ host: '-bad' }, 'echo hi', {})).rejects.toThrow(/unsafe/);
  expect(called).toBe(false);
});

// L1: the default-shell dedup used `sed -i '#^set-option…#d'` — a '#'-led sed
// script is a COMMENT, so nothing was ever deleted and every omz/omb ensure
// run appended another `set-option -g default-shell` line to .tmux.conf.local
// (and appended it even when oh-my-tmux — the only thing that sources that
// file — was never installed).
test('default-shell dedup sed uses a real address, not a #-comment, and is guarded by file existence', () => {
  const z = buildEnsureTmuxRemote('web', undefined, { installOhMyZsh: true });
  expect(z).toContain("sed -i '/^set-option -g default-shell/d'");
  expect(z).not.toContain("sed -i '#^set-option");
  expect(z).toContain('if [ -f .tmux.conf.local ]');
  const b = buildEnsureTmuxRemote('web', undefined, { installOhMyBash: true });
  expect(b).toContain("sed -i '/^set-option -g default-shell/d'");
  expect(b).not.toContain("sed -i '#^set-option");
});

test('omz ensure replaces prior default-shell lines instead of appending another (verified with real sed)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-dedup-'));
  for (const bin of ['zsh', 'tmux', 'git', 'curl']) {
    await fs.writeFile(path.join(dir, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  await fs.mkdir(path.join(dir, '.oh-my-zsh')); // installer skipped
  // Real sed via a wrapper so the dedup actually executes under the fake PATH.
  const realSed = await fs.stat('/usr/bin/sed').then(() => '/usr/bin/sed').catch(() => '/bin/sed');
  await fs.writeFile(path.join(dir, 'sed'), `#!/bin/sh\nexec ${realSed} "$@"\n`, { mode: 0o755 });
  // Two stale lines from previous ensure runs, plus an unrelated keeper.
  await fs.writeFile(path.join(dir, '.tmux.conf.local'),
    'set -g history-limit 5000\nset-option -g default-shell "/usr/bin/oldzsh"\nset-option -g default-shell "/usr/bin/olderzsh"\n');

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyZsh: true })}`, { PATH: dir });

  expect(res.code).toBe(0);
  const conf = await fs.readFile(path.join(dir, '.tmux.conf.local'), 'utf8');
  const shellLines = conf.split('\n').filter((l) => l.startsWith('set-option -g default-shell'));
  expect(shellLines).toHaveLength(1);                          // deduped, not appended
  expect(shellLines[0]).toContain(path.join(dir, 'zsh'));      // points at the detected zsh
  expect(conf).toContain('set -g history-limit 5000');         // unrelated config untouched
});

test('omz ensure without oh-my-tmux does not create a stray .tmux.conf.local', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-nostray-'));
  for (const bin of ['zsh', 'tmux', 'git', 'curl']) {
    await fs.writeFile(path.join(dir, bin), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  await fs.mkdir(path.join(dir, '.oh-my-zsh'));

  const res = await runShell(`cd ${JSON.stringify(dir)}
${buildEnsureTmuxRemote('web', undefined, { installOhMyZsh: true })}`, { PATH: dir });

  expect(res.code).toBe(0);
  await expect(fs.stat(path.join(dir, '.tmux.conf.local'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('resolveTools returns [] for empty input', () => {
  expect(resolveTools(undefined)).toEqual([]);
  expect(resolveTools(null)).toEqual([]);
  expect(resolveTools('')).toEqual([]);
  expect(resolveTools([])).toEqual([]);
});

test('resolveTools rejects unknown ids', () => {
  expect(() => resolveTools(['curl', 'rm -rf /'])).toThrow(/unknown tool/);
  expect(() => resolveTools('curl,$(reboot)')).toThrow(/unknown tool/);
});

test('resolveTools parses CSV, dedupes, and orders by TOOL_IDS', () => {
  expect(resolveTools('git,curl,git')).toEqual(['curl', 'git']);
  expect(resolveTools(['bubblewrap', 'upgrade'])).toEqual(['upgrade', 'bubblewrap']);
});

test('resolveTools applies dependency implications', () => {
  expect(resolveTools(['codex'])).toEqual(['node', 'codex']);
  expect(resolveTools(['claude'])).toEqual(['curl', 'claude']);
  expect(resolveTools(['agy'])).toEqual(['curl', 'agy']);
  expect(resolveTools(['gh'])).toEqual(['curl', 'gh']);
});

test('TOOL_IDS lists every tool in install order', () => {
  expect(TOOL_IDS).toEqual(['upgrade', 'curl', 'git', 'gh', 'node', 'bubblewrap', 'codex', 'claude', 'agy']);
});

test('buildEnsureTmuxRemote includes system upgrade block when requested', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['upgrade'] });
  expect(remote).toContain('apt-get -y upgrade');
  expect(remote).toContain('dnf -y upgrade');
  expect(remote).toContain('pacman -Syu --noconfirm');
  expect(remote).toContain('apk upgrade --update-cache');
  expect(remote).toContain('zypper --non-interactive update');
});

test('buildEnsureTmuxRemote installs distro packages with command guards', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['curl', 'bubblewrap'] });
  expect(remote).toContain('if ! command -v curl >/dev/null 2>&1; then');
  expect(remote).toContain('apt-get install -y --no-install-recommends curl');
  expect(remote).toContain('if ! command -v bwrap >/dev/null 2>&1; then');
  expect(remote).toContain('apt-get install -y --no-install-recommends bubblewrap');
});

test('buildEnsureTmuxRemote sets up the GitHub apt repo for gh', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['gh'] });
  expect(remote).toContain('https://cli.github.com/packages/githubcli-archive-keyring.gpg');
  expect(remote).toContain('/etc/apt/sources.list.d/github-cli.list');
  expect(remote).toContain('apt-get install -y --no-install-recommends gh');
  expect(remote).toContain('pacman -Sy --noconfirm github-cli');
  // gh implies curl (fetches the keyring with it)
  expect(remote).toContain('if ! command -v curl >/dev/null 2>&1; then');
});

// RHEL/CentOS carry no gh package — GitHub's rpm repo must be added before
// dnf/yum install, same temp-file-first shape as the apt keyring (a failed
// curl aborts before anything under /etc is mutated).
test('buildEnsureTmuxRemote sets up the GitHub rpm repo for gh on dnf/yum', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['gh'] });
  expect(remote).toContain('https://cli.github.com/packages/rpm/gh-cli.repo');
  expect(remote).toContain('/etc/yum.repos.d/gh-cli.repo');
  const repoAt = remote.indexOf('/etc/yum.repos.d/gh-cli.repo');
  expect(repoAt).toBeLessThan(remote.indexOf('dnf install -y gh'));
  expect(repoAt).toBeLessThan(remote.indexOf('yum install -y gh'));
});

test('buildEnsureTmuxRemote installs codex via npm with node implied', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['codex'] });
  expect(remote).toContain('if ! command -v npm >/dev/null 2>&1; then');
  expect(remote).toContain('apt-get install -y --no-install-recommends nodejs npm');
  expect(remote).toContain('npm install -g @openai/codex');
});

test('buildEnsureTmuxRemote installs claude and agy via their curl installers', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['claude', 'agy'] });
  // Download-then-execute (not pipe-to-bash): a curl failure is a plain command
  // that `set -e` catches, so a network error can't report success with the tool
  // absent (pipefail can't be assumed — the remote may run dash).
  expect(remote).toContain('curl -fsSL https://claude.ai/install.sh -o "$t"');
  expect(remote).toContain('curl -fsSL https://antigravity.google/cli/install.sh -o "$t"');
  expect(remote).not.toContain('install.sh | bash');
  expect(remote).toContain('$HOME/.local/bin:$PATH');
});

test('buildEnsureTmuxRemote keeps upgrade first AMONG the tools (fresh indexes for later tool installs)', () => {
  // The tools now run after the tmux bootstrap (see the tmux-before-tools test),
  // but upgrade must still lead the tool blocks so curl/git/gh/node see fresh
  // package indexes.
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['upgrade', 'node'] });
  expect(remote.indexOf('apt-get -y upgrade')).toBeLessThan(remote.indexOf('nodejs npm'));
});

test('buildEnsureTmuxRemote omits tool blocks and PATH line when no tools selected', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, {});
  expect(remote).not.toContain('@openai/codex');
  expect(remote).not.toContain('cli.github.com');
  expect(remote).not.toContain('.local/bin');
  expect(remote).not.toContain('apt-get -y upgrade');
});

test('buildEnsureTmuxRemote rejects unknown tool ids', () => {
  expect(() => buildEnsureTmuxRemote('web', undefined, { tools: ['evil'] })).toThrow(/unknown tool/);
});

test('local-bin PATH line is delete-then-append idempotent (real sed)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-path-'));
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['claude'] });
  // Extract just the PATH-maintenance block (from the .profile guard through done).
  const lines = remote.split('\n');
  const start = lines.findIndex((l) => l.includes('$HOME/.profile'));
  const end = lines.findIndex((l, i) => i > start && l === 'done');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = lines.slice(start, end + 1).join('\n');
  const env = { HOME: dir };
  await runShell(block, env);
  await runShell(block, env);
  const profile = await fs.readFile(path.join(dir, '.profile'), 'utf8');
  const count = profile.split('\n').filter((l) => l.includes('.local/bin')).length;
  expect(count).toBe(1);
});

// The Oh My Zsh / Oh My Bash installers REPLACE .zshrc / .bashrc, so the
// ~/.local/bin PATH block must run after the framework blocks or the line the
// claude/agy installers rely on is wiped (or never written — the loop skips rc
// files that don't exist yet).
test('local-bin PATH block runs after the shell-framework installs', () => {
  const remote = buildEnsureTmuxRemote('web', undefined, {
    tools: ['claude'],
    installOhMyZsh: true,
    installOhMyBash: true,
  });
  const pathAt = remote.indexOf('tmuxifier-local-bin');
  expect(pathAt).toBeGreaterThan(-1);
  expect(pathAt).toBeGreaterThan(remote.indexOf('.oh-my-zsh'));
  expect(pathAt).toBeGreaterThan(remote.indexOf('.oh-my-bash'));
});

// Important #1: the claude/agy installers must fail loudly. Piping `curl | bash`
// under `set -eu` (no pipefail) reports success on a curl network failure —
// bash on empty stdin exits 0, so the pipeline exits 0 and the tool is silently
// absent. Download-then-execute makes the fetch a plain command `set -e` catches.
test('claude installer fails loudly when the download fails (real shell, curl exit 7)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-claude-fail-'));
  // PATH holds ONLY our stubs, so `command -v claude` deterministically misses
  // (claude is often on the test host's PATH) and the install body runs.
  await fs.writeFile(path.join(dir, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o755 }); // simulate a network failure
  // Passthrough real mktemp/bash/rm by restoring the original PATH first.
  for (const name of ['mktemp', 'bash', 'rm']) {
    await fs.writeFile(path.join(dir, name), `#!/bin/sh\nexport PATH="$ORIG_PATH"\nexec ${name} "$@"\n`, { mode: 0o755 });
  }
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['claude'] });
  const lines = remote.split('\n');
  const start = lines.findIndex((l) => /command -v claude/.test(l));
  const end = lines.findIndex((l, i) => i > start && l.trim() === 'fi');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = `set -eu\n${lines.slice(start, end + 1).join('\n')}`;
  const res = await runShell(block, { PATH: dir, ORIG_PATH: process.env.PATH, HOME: dir });
  // A curl failure must abort the block — not report success with claude absent.
  expect(res.code).not.toBe(0);
});

// Important #2: the gh apt branch must fetch the keyring to a temp file BEFORE
// any /etc mutation. The old `curl … | $SUDO tee /etc/apt/keyrings/…` wrote an
// EMPTY keyring on curl failure (tee exits 0), and the sources list still
// landed — poisoning every later `apt-get update` on the box.
test('gh keyring fetch aborts before writing the keyring when curl fails (real shell)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-gh-fail-'));
  const keyrings = path.join(dir, 'keyrings');
  const sources = path.join(dir, 'sources');
  await fs.mkdir(keyrings);
  await fs.mkdir(sources);
  await fs.writeFile(path.join(dir, 'curl'), '#!/bin/sh\nexit 7\n', { mode: 0o755 }); // simulate a network failure
  await fs.writeFile(path.join(dir, 'apt-get'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // present => apt branch taken
  await fs.writeFile(path.join(dir, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 }); // "root" => SUDO=''
  // Passthrough the real tools that would actually touch the (redirected) dirs.
  for (const name of ['mkdir', 'mktemp', 'install', 'tee', 'rm', 'chmod', 'dpkg']) {
    await fs.writeFile(path.join(dir, name), `#!/bin/sh\nexport PATH="$ORIG_PATH"\nexec ${name} "$@"\n`, { mode: 0o755 });
  }
  const remote = buildEnsureTmuxRemote('web', undefined, { tools: ['gh'] });
  const lines = remote.split('\n');
  const start = lines.findIndex((l) => /command -v gh/.test(l));
  // Find the matching OUTER `fi` (ignore self-balanced one-line `if …; fi`).
  let depth = 0, end = -1;
  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^if\b.*;\s*fi$/.test(t)) continue;
    if (/^if\b/.test(t)) depth++;
    else if (t === 'fi') { depth--; if (depth === 0) { end = i; break; } }
  }
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const block = `set -eu\n${lines.slice(start, end + 1).join('\n')}`
    .replaceAll('/etc/apt/keyrings', keyrings)
    .replaceAll('/etc/apt/sources.list.d', sources);
  const res = await runShell(block, { PATH: dir, ORIG_PATH: process.env.PATH, HOME: dir });
  // curl failed, so the keyring must never have been written — an empty/broken
  // keyring would poison every later apt-get update on the box.
  expect(res.code).not.toBe(0);
  await expect(fs.readdir(keyrings)).resolves.toEqual([]);
});

// Suite-level lock: the full script (every tool + every framework) must parse
// cleanly. Catches quoting / unbalanced-block regressions from future edits.
test('generated setup script is syntactically valid with all tools and frameworks (sh -n)', async () => {
  const remote = buildEnsureTmuxRemote('web', "echo 'hi'", {
    tools: TOOL_IDS,
    installOhMyTmux: true,
    installOhMyZsh: true,
    installOhMyBash: true,
  });
  const res = await syntaxCheck(remote);
  expect(res.stderr).toBe('');
  expect(res.code).toBe(0);
});
