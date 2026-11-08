import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnsureLocalShellScript, createLocalShellActions, runLocalScriptStdin } from '../src/server/localShellActions.js';
import { buildAgentHooksInstallScript } from '../src/server/claudeAgentHooks.js';
import { buildOpencodePluginInstallScript } from '../src/server/opencodeAgentPlugin.js';
import { buildOscReporterInstallScript } from '../src/server/oscReporter.js';
import { buildVoiceWriterRemote } from '../src/server/voiceWriter.js';
import { buildVoiceLinkInstallScript } from '../src/server/claudeVoiceLink.js';

test('buildEnsureLocalShellScript installs Oh My Zsh without creating a session or killing live windows', () => {
  const script = buildEnsureLocalShellScript('omz');

  expect(script).toContain('https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh');
  expect(script).toContain('apt-get install -y --no-install-recommends zsh');
  expect(script).not.toContain('new-session');
  expect(script).not.toContain('respawn-window');
  expect(script).toContain('"$TMUX_BIN" has-session -t \'=local\'');
  expect(script).toContain('"$TMUX_BIN" set-option -t \'=local:\' default-shell "$ZSH_BIN"');
});

test('buildEnsureLocalShellScript installs Oh My Bash without creating a session or killing live windows', () => {
  const script = buildEnsureLocalShellScript('omb');

  expect(script).toContain('https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh');
  expect(script).not.toContain('new-session');
  expect(script).not.toContain('respawn-window');
  expect(script).toContain('"$TMUX_BIN" has-session -t \'=local\'');
  expect(script).toContain('"$TMUX_BIN" set-option -t \'=local:\' default-shell "$BASH_BIN"');
});

test('createLocalShellActions runs framework setup from the user home directory', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    run: async (script, opts) => {
      calls.push({ script, opts });
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  await expect(actions.ensureReady('omz')).resolves.toEqual({ ok: true });

  expect(calls).toHaveLength(1);
  expect(calls[0].script).toContain('ohmyzsh/ohmyzsh');
  expect(calls[0].opts.cwd).toBe(os.homedir());
  expect(calls[0].opts.timeout).toBe(120000);
});

test('createLocalShellActions skips setup for none', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    run: async (script, opts) => {
      calls.push({ script, opts });
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  await expect(actions.ensureReady('none')).resolves.toEqual({ ok: true });

  expect(calls).toEqual([]);
});

test('the ensure script targets the configured tmux session name with an exact = match', async () => {
  const custom = String(buildEnsureLocalShellScript('omz', 'sess42'));
  expect(custom).toContain("'=sess42'");
  const scripts = [];
  const actions = createLocalShellActions({
    run: async (script) => { scripts.push(String(script)); return { code: 0, stdout: '', stderr: '' }; },
    localSession: 'sess42',
  });
  await actions.ensureReady('omz');
  expect(scripts[0]).toContain("'=sess42'");
});

test('ensureReady against an isolated tmux socket neither spawns an un-scoped server nor kills a live window in =local', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lsa-tmux-'));
  const home = path.join(dir, 'home');
  const tmuxTmp = path.join(dir, 'tmux');
  await fs.promises.mkdir(home, { recursive: true });
  await fs.promises.mkdir(tmuxTmp, { recursive: true, mode: 0o700 });
  // Pre-seed framework dirs so ensureReady skips network clones and exercises
  // the real shell + tmux commands end-to-end.
  await fs.promises.mkdir(path.join(home, '.tmux'), { recursive: true });
  await fs.promises.writeFile(path.join(home, '.tmux', '.tmux.conf'), '');
  await fs.promises.writeFile(path.join(home, '.tmux.conf.local'), '');
  await fs.promises.mkdir(path.join(home, '.oh-my-bash'), { recursive: true });
  await fs.promises.writeFile(path.join(home, '.bashrc'), 'source "$OSH"/oh-my-bash.sh\n');
  const { TMUX: _drop, ...cleanEnv } = process.env;
  const env = { ...cleanEnv, HOME: home, TMUX_TMPDIR: tmuxTmp };
  const actions = createLocalShellActions({ cwd: home, env, localSession: 'local' });

  try {
    // 1. With no =local session running, ensureReady must NOT start a tmux server
    //    (that is localTmuxScope's job under systemd-run --scope).
    await actions.ensureReady('omb');
    expect(() => execFileSync('tmux', ['has-session', '-t', '=local'], { env, stdio: 'ignore' })).toThrow();

    // 2. With only a prefix-twin =local2 running, ensureReady must not create
    //    =local or touch =local2.
    execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', 'local2', 'sleep 60'], { env });
    await actions.ensureReady('omb');
    expect(() => execFileSync('tmux', ['has-session', '-t', '=local'], { env, stdio: 'ignore' })).toThrow();
    expect(execFileSync('tmux', ['show-options', '-t', '=local2:', '-v', 'default-shell'], { env, encoding: 'utf8' }).trim()).toBe('');

    // 3. With a live =local session, ensureReady leaves window 1's PID untouched
    //    and sets default-shell only on =local.
    execFileSync('tmux', ['new-session', '-d', '-s', 'local', 'sleep 60'], { env });
    const pidBefore = execFileSync('tmux', ['list-panes', '-t', '=local', '-F', '#{pane_pid}'], { env, encoding: 'utf8' }).trim();

    await actions.ensureReady('omb');

    const pidAfter = execFileSync('tmux', ['list-panes', '-t', '=local', '-F', '#{pane_pid}'], { env, encoding: 'utf8' }).trim();
    const localShellAfter = execFileSync('tmux', ['show-options', '-t', '=local:', '-v', 'default-shell'], { env, encoding: 'utf8' }).trim();
    const local2ShellAfter = execFileSync('tmux', ['show-options', '-t', '=local2:', '-v', 'default-shell'], { env, encoding: 'utf8' }).trim();
    expect(pidAfter).toBe(pidBefore);
    expect(localShellAfter).toMatch(/bash$/);
    expect(local2ShellAfter).toBe('');
  } finally {
    try { execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' }); } catch { /* already gone */ }
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('installAgentHooks runs the standard install script locally with the hook bytes on stdin', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    runStdin: async (script, input, opts) => {
      calls.push({ script, input, opts });
      return { code: 0, stdout: 'AGENTHOOKS: applied\n', stderr: '' };
    },
    readHookAsset: async () => Buffer.from('#!/bin/sh\nhook-body\n'),
  });

  await expect(actions.installAgentHooks()).resolves.toEqual({ target: 'agent-hooks', ok: true });
  expect(calls).toHaveLength(1);
  // The exact same installer the SSH pusher sends — local transport, zero drift.
  expect(calls[0].script).toBe(buildAgentHooksInstallScript());
  expect(calls[0].input.toString()).toContain('hook-body');
  expect(calls[0].opts.cwd).toBe(os.homedir());
});

test('installAgentHooks maps skipped-no-claude', async () => {
  const actions = createLocalShellActions({
    runStdin: async () => ({ code: 0, stdout: 'AGENTHOOKS: skipped-no-claude\n', stderr: '' }),
    readHookAsset: async () => Buffer.from('x'),
  });
  const res = await actions.installAgentHooks();
  expect(res.ok).toBe(false);
  expect(res.skipped).toBeTruthy();
});

test('installAgentHooks reports a failed run as an error result, never a throw', async () => {
  const actions = createLocalShellActions({
    runStdin: async () => ({ code: 4, stdout: '', stderr: 'jq: not found' }),
    readHookAsset: async () => Buffer.from('x'),
  });
  const res = await actions.installAgentHooks();
  expect(res.ok).toBe(false);
  expect(res.error).toBeTruthy();
});

test('installOpencodePlugin runs the install script locally with the plugin bytes on stdin', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    runStdin: async (script, input, opts) => {
      calls.push({ script, input, opts });
      return { code: 0, stdout: 'OPENCODEPLUGIN: applied\n', stderr: '' };
    },
    readOpencodeAsset: async () => Buffer.from('plugin-body'),
  });

  await expect(actions.installOpencodePlugin()).resolves.toEqual({ target: 'opencode-plugin', ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].script).toBe(buildOpencodePluginInstallScript());
  expect(calls[0].input.toString()).toContain('plugin-body');
  expect(calls[0].opts.cwd).toBe(os.homedir());
});

test('installOpencodePlugin maps skipped-no-opencode', async () => {
  const actions = createLocalShellActions({
    runStdin: async () => ({ code: 0, stdout: 'OPENCODEPLUGIN: skipped-no-opencode\n', stderr: '' }),
    readOpencodeAsset: async () => Buffer.from('x'),
  });
  const res = await actions.installOpencodePlugin();
  expect(res.ok).toBe(false);
  expect(res.skipped).toBeTruthy();
});

// --- the default spawn transport --------------------------------------------
// Every test above injects `runStdin`, so the real transport — the only
// production I/O path in this module — was never executed by the suite. These
// two run it against a real /bin/sh.

test('runLocalScriptStdin feeds stdin to a real shell and collects its output', async () => {
  const res = await runLocalScriptStdin('cat', Buffer.from('x'), { timeout: 5000 });
  expect(res).toEqual({ code: 0, stdout: 'x', stderr: '' });
});

// The timer used to kill the child and then wait for 'close', which fires on
// stdio EOF — not on exit. A grandchild holding the inherited stdout would
// leave this promise (and the HTTP request awaiting it) pending forever, so
// the timeout must settle the promise itself.
test('runLocalScriptStdin settles on timeout instead of hanging', async () => {
  const started = Date.now();
  const res = await runLocalScriptStdin('sleep 30', Buffer.from(''), { timeout: 100 });
  expect(res.code).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(5000);
});

test('installVoiceLink runs the standard voice-link installer locally with empty stdin', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    runStdin: async (script, input, opts) => { calls.push({ script, input, opts }); return { code: 0, stdout: 'VOICELINK: applied settings=kept\n', stderr: '' }; },
  });
  await expect(actions.installVoiceLink()).resolves.toEqual({ target: 'voice-link', ok: true, settings: 'kept' });
  expect(calls[0].script).toBe(buildVoiceLinkInstallScript());
  expect(calls[0].input.length).toBe(0);
  expect(calls[0].opts.cwd).toBe(os.homedir());
});

test('openAudioSink runs the writer remote under /bin/sh with the factory env', () => {
  const calls = [];
  const handle = { stdin: {}, done: Promise.resolve({ code: 0 }), kill() {} };
  const actions = createLocalShellActions({ env: { HOME: '/tmp/x', PATH: '/usr/bin' }, pipe: (argv, opts) => { calls.push({ argv, opts }); return handle; } });
  expect(actions.openAudioSink()).toBe(handle);
  expect(calls[0].argv).toEqual(['-c', buildVoiceWriterRemote()]);
  expect(calls[0].opts.cmd).toBe('/bin/sh');
  expect(calls[0].opts.env).toEqual({ HOME: '/tmp/x', PATH: '/usr/bin' });
});

test('installOscReporter runs the OSC reporter install script locally with the asset on stdin', async () => {
  const calls = [];
  const actions = createLocalShellActions({
    runStdin: async (script, input, opts) => {
      calls.push({ script, input, opts });
      return { code: 0, stdout: 'OSCREPORTER: applied\n', stderr: '' };
    },
    readOscAsset: async () => Buffer.from('osc-body'),
  });
  await expect(actions.installOscReporter()).resolves.toEqual({ target: 'osc-reporter', ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0].script).toBe(buildOscReporterInstallScript());
  expect(calls[0].input.toString()).toContain('osc-body');
  expect(calls[0].opts.cwd).toBe(os.homedir());
});
