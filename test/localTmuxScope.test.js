import { test, expect } from 'vitest';
import { buildScopedNewSessionArgv, buildHasSessionArgv, createLocalTmuxScope } from '../src/server/localTmuxScope.js';

test('buildHasSessionArgv: exact-match target, never a prefix match', () => {
  // tmux target resolution prefix-matches bare names; `=` pins it exact so a
  // session named "local-scratch" can never satisfy the check for "local".
  expect(buildHasSessionArgv('local')).toEqual(['tmux', ['has-session', '-t', '=local']]);
});

test('buildScopedNewSessionArgv: systemd-run scope wraps a detached new-session', () => {
  const [cmd, args] = buildScopedNewSessionArgv('local', 'none');
  expect(cmd).toBe('systemd-run');
  // --scope: stay in the caller's environment, only the cgroup moves — that
  // cgroup move is the entire point (out of tmuxifier.service's kill radius).
  // --collect: a failed or emptied scope cleans itself up.
  expect(args.slice(0, 3)).toEqual(['--scope', '--collect', '--quiet']);
  const sep = args.indexOf('--');
  expect(sep).toBeGreaterThan(0);
  // -d: the server starts with no attached client; the pty only ever attaches.
  expect(args.slice(sep + 1)).toEqual(['tmux', '-u', 'new-session', '-d', '-s', 'local']);
});

test('buildScopedNewSessionArgv: shell frameworks map exactly as openLocal maps them', () => {
  const tail = (shell) => {
    const [, args] = buildScopedNewSessionArgv('local', shell);
    return args.slice(args.indexOf('--') + 1);
  };
  expect(tail('omz').at(-1)).toBe('exec zsh');
  expect(tail('omb').at(-1)).toBe('exec bash');
  expect(tail('nonsense').at(-1)).toBe('local'); // unknown shell adds no command
});

test('ensure: an alive session means no systemd-run call', async () => {
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, args]); };
  const scope = createLocalTmuxScope({ exec });
  const r = await scope.ensure('none');
  expect(r).toEqual({ created: false });
  expect(calls).toEqual([['tmux', ['has-session', '-t', '=local']]]);
});

test('ensure: a missing session is created inside a transient scope', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'tmux') throw new Error('no session');
  };
  const scope = createLocalTmuxScope({ exec });
  const r = await scope.ensure('omz');
  expect(r).toEqual({ created: true });
  expect(calls[1][0]).toBe('systemd-run');
  expect(calls[1][1].at(-1)).toBe('exec zsh');
});

test('ensure: never throws — a host without systemd-run falls back to the old path', async () => {
  const exec = async (cmd) => {
    const err = new Error(cmd === 'tmux' ? 'no session' : 'spawn systemd-run ENOENT');
    if (cmd === 'systemd-run') err.code = 'ENOENT';
    throw err;
  };
  const logged = [];
  const scope = createLocalTmuxScope({ exec, log: (m) => logged.push(m) });
  // The pty client's own new-session -A still auto-starts a server, so a
  // failed ensure costs restart-survival, never the terminal itself.
  await expect(scope.ensure('none')).resolves.toEqual({ created: false });
  expect(logged.length).toBe(1);
  // The fallback is remembered: later ensures skip straight to no-op instead
  // of re-probing systemd-run on every viewer connect.
  await expect(scope.ensure('none')).resolves.toEqual({ created: false });
  expect(logged.length).toBe(1);
});

test('ensure: concurrent viewers share one flight', async () => {
  const calls = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const exec = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'tmux') { await gate; throw new Error('no session'); }
  };
  const scope = createLocalTmuxScope({ exec });
  const a = scope.ensure('none');
  const b = scope.ensure('none');
  release();
  expect(await a).toEqual({ created: true });
  expect(await b).toEqual({ created: true });
  // One has-session probe and one systemd-run for two simultaneous viewers.
  expect(calls.length).toBe(2);
});
