import { test, expect } from 'vitest';
import os from 'node:os';
import { buildEnsureLocalShellScript, createLocalShellActions } from '../src/server/localShellActions.js';
import { buildAgentHooksInstallScript } from '../src/server/claudeAgentHooks.js';

test('buildEnsureLocalShellScript enables Oh My Zsh in local tmux session', () => {
  const script = buildEnsureLocalShellScript('omz');

  expect(script).toContain('https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh');
  expect(script).toContain('apt-get install -y --no-install-recommends zsh');
  expect(script).toContain('"$TMUX_BIN" has-session -t \'local\'');
  expect(script).toContain('"$TMUX_BIN" set-option -g default-shell "$ZSH_BIN"');
  expect(script).toContain('respawn-window -t \'local\':$W -k "$ZSH_BIN"');
});

test('buildEnsureLocalShellScript enables Oh My Bash in local tmux session', () => {
  const script = buildEnsureLocalShellScript('omb');

  expect(script).toContain('https://raw.githubusercontent.com/ohmybash/oh-my-bash/master/tools/install.sh');
  expect(script).toContain('"$TMUX_BIN" has-session -t \'local\'');
  expect(script).toContain('"$TMUX_BIN" set-option -g default-shell "$BASH_BIN"');
  expect(script).toContain('respawn-window -t \'local\':$W -k "$BASH_BIN"');
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

test('the ensure script targets the configured tmux session name, not a hardcoded local', async () => {
  const custom = String(buildEnsureLocalShellScript('omz', 'sess42'));
  expect(custom).toContain('sess42');
  const scripts = [];
  const actions = createLocalShellActions({
    run: async (script) => { scripts.push(String(script)); return { code: 0, stdout: '', stderr: '' }; },
    localSession: 'sess42',
  });
  await actions.ensureReady('omz');
  expect(scripts[0]).toContain('sess42');
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
