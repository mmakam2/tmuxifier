import { test, expect } from 'vitest';
import os from 'node:os';
import { buildEnsureLocalShellScript, createLocalShellActions } from '../src/server/localShellActions.js';

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
