import { test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createWorkerBench } from './helpers/workerBench.js';
import {
  WORKER_CODES, buildWorkerStartRemote, parseWorkerResult,
} from '../src/server/agentWorkers.js';

// The worker start script against a REAL tmux server, under every pairing of the shell the
// script runs in (the box's login shell: sh, bash, zsh) and tmux's default-shell (bash, zsh).
// The launch line's `"$SHELL"` is expanded inside tmux, which sets SHELL to its default-shell
// for the command it runs; only a real server shows that, and only a real interactive shell
// reading the box's rc files shows that the agent is found and the token is exported.
//
// Isolation: test/helpers/workerBench.js (a private tmux server on its own -L socket under a
// private TMUX_TMPDIR and HOME, an environment built from scratch). A missing shell fails the
// suite loudly instead of skipping, as a missing sshd does in localBox.js.
//
// `no-tmux` is not exercised behaviourally: every machine this suite runs on has
// /usr/bin/tmux, which the script's fallback sweep finds. It is pinned by parseWorkerResult
// and by the branch's presence in the built script.

const SESSION = 'worker-api-1';
const SCRIPT_SHELLS = ['sh', 'bash', 'zsh'];
const DEFAULT_SHELLS = ['bash', 'zsh'];

const benches = [];
afterEach(async () => {
  for (const b of benches.splice(0)) await b.cleanup();
});

function bench(defaultShell) {
  const b = createWorkerBench({ defaultShell });
  benches.push(b);
  return b;
}

// A project directory inside the bench's temp tree (always a path isWorkerDir accepts).
function projectDir(b) {
  const dir = path.join(b.home, 'billing-api');
  mkdirSync(dir, { recursive: true });
  return dir;
}

const sessionsOf = (b) => {
  let out = '';
  try { out = b.tmux('list-sessions', '-F', '#{session_name}'); } catch { return []; }
  return out.split('\n').filter(Boolean);
};

async function waitFor(fn, { ms = 5000, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

for (const scriptShell of SCRIPT_SHELLS) {
  for (const defaultShell of DEFAULT_SHELLS) {
    test(`script under ${scriptShell}, tmux default-shell ${defaultShell}: started, then exists`, async () => {
      const b = bench(defaultShell);
      const dir = projectDir(b);
      const remote = buildWorkerStartRemote({ session: SESSION, dir });

      const first = b.run(scriptShell, remote);
      expect(first).toEqual({ code: 0, stdout: 'WORKER: started\n' });
      expect(parseWorkerResult(first.stdout)).toBe('started');
      const expected = `token=set cwd=${dir} tty=yes`;
      await waitFor(() => b.standInLog(SESSION) === expected, { what: `stand-in log ${expected}` });
      expect(sessionsOf(b)).toEqual([SESSION]);

      const second = b.run(scriptShell, remote);
      expect(second).toEqual({ code: 0, stdout: 'WORKER: exists\n' });
      expect(parseWorkerResult(second.stdout)).toBe('exists');
      expect(sessionsOf(b)).toEqual([SESSION]);
      expect(b.tmux('list-panes', '-a', '-F', '#{pane_id}').split('\n').filter(Boolean)).toHaveLength(1);
    });
  }
}

// A KNOWN LIMITATION, pinned as it is today (the launch line is not changed for it): with tmux's
// default-shell `sh` (dash on Debian and Ubuntu), the launch line's `"$SHELL" -ic` is an
// interactive dash, which reads no rc file (only $ENV), so a `claude` found only through the rc
// files' ~/.local/bin line is not found and the pane ends. The script still answers `started`:
// its own check finds the agent in ~/.local/bin. The operator guide says to use bash or zsh.
test('known limitation: tmux default-shell sh prints started, but the agent found only via ~/.local/bin never comes up', async () => {
  const b = bench('sh');
  const dir = projectDir(b);
  const r = b.run('sh', buildWorkerStartRemote({ session: SESSION, dir }));
  expect(r).toEqual({ code: 0, stdout: 'WORKER: started\n' });
  // Give the pane the time the other cases need to write their line (they do it well inside 5 s).
  await new Promise((res) => setTimeout(res, 2000));
  expect(b.standInLog(SESSION)).toBeNull();
  expect(sessionsOf(b)).toEqual([]); // the pane's shell exited, and the session with it
});

for (const scriptShell of SCRIPT_SHELLS) {
  test(`script under ${scriptShell}: a missing directory is no-dir, a missing agent is no-agent-binary`, () => {
    const b = bench('bash');
    const missing = path.join(b.home, 'not-there');
    const noDir = b.run(scriptShell, buildWorkerStartRemote({ session: SESSION, dir: missing }));
    expect(noDir).toEqual({ code: 0, stdout: 'WORKER: no-dir\n' });
    expect(parseWorkerResult(noDir.stdout)).toBe('no-dir');
    expect(sessionsOf(b)).toEqual([]);

    rmSync(path.join(b.home, '.local', 'bin', 'claude'));
    const noAgent = b.run(scriptShell, buildWorkerStartRemote({ session: SESSION, dir: projectDir(b) }));
    expect(noAgent).toEqual({ code: 0, stdout: 'WORKER: no-agent-binary\n' });
    expect(parseWorkerResult(noAgent.stdout)).toBe('no-agent-binary');
    expect(sessionsOf(b)).toEqual([]);
  });
}

test('a tmux failure on the launch exits non-zero with no WORKER line', () => {
  const b = bench('bash');
  // A `tmux` that fails every call, first on PATH: has-session reads as "no such session" and
  // the launch fails. It runs no real tmux at all. (Not a bad TMUX_TMPDIR: tmux 3.6 falls back
  // to /tmp when TMUX_TMPDIR is unusable, which would put a server outside the bench.)
  const failing = path.join(b.home, 'failing-tmux');
  mkdirSync(failing);
  writeFileSync(path.join(failing, 'tmux'), '#!/bin/sh\nexit 1\n');
  chmodSync(path.join(failing, 'tmux'), 0o755);
  const remote = `PATH=${failing}:$PATH; export PATH\n`
    + buildWorkerStartRemote({ session: SESSION, dir: projectDir(b) });
  for (const shell of SCRIPT_SHELLS) {
    const r = b.run(shell, remote);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(parseWorkerResult(r.stdout)).toBeNull();
  }
  expect(sessionsOf(b)).toEqual([]);
});

test('buildWorkerStartRemote refuses a bad session, directory or agent', () => {
  const ok = { session: SESSION, dir: '/opt/billing-api' };
  expect(() => buildWorkerStartRemote(ok)).not.toThrow();
  for (const session of ['a b', '=x', '']) {
    expect(() => buildWorkerStartRemote({ ...ok, session })).toThrow(Error);
  }
  for (const dir of ["/opt/x'", '/opt/x y', '/opt/../x']) {
    expect(() => buildWorkerStartRemote({ ...ok, dir })).toThrow(Error);
  }
  expect(() => buildWorkerStartRemote({ ...ok, agent: 'codex' })).toThrow(Error);
  // An own key only: a name inherited from Object.prototype is not an agent.
  expect(() => buildWorkerStartRemote({ ...ok, agent: 'toString' })).toThrow(Error);
});

test('the built script names the session only as an exact, quoted target', () => {
  const remote = buildWorkerStartRemote({ session: SESSION, dir: '/opt/billing-api' });
  expect(remote).toContain(`has-session -t '=${SESSION}'`);
  expect(remote).not.toMatch(/-t worker-api-1/);
  const rest = remote.replaceAll(`'=${SESSION}'`, '').replaceAll(`'${SESSION}'`, '');
  expect(rest).not.toContain(SESSION);
});

test('the built script carries the launch line verbatim and a no-tmux branch', () => {
  const remote = buildWorkerStartRemote({ session: SESSION, dir: '/opt/billing-api' });
  expect(remote).toContain(
    `new-session -d -s '${SESSION}' -c '/opt/billing-api' 'exec "$SHELL" -ic '\\''exec claude'\\'''`,
  );
  expect(remote).toContain("echo 'WORKER: no-tmux'");
  expect(remote.split('\n')[0]).toBe('set -eu');
});

test('WORKER_CODES is the closed, frozen list', () => {
  expect(WORKER_CODES).toEqual(['started', 'exists', 'no-tmux', 'no-dir', 'no-agent-binary']);
  expect(Object.isFrozen(WORKER_CODES)).toBe(true);
});

test('parseWorkerResult reads only the last exact WORKER line with a known code', () => {
  expect(parseWorkerResult('noise\nWORKER: started\n')).toBe('started');
  expect(parseWorkerResult('WORKER: started extra')).toBeNull();
  expect(parseWorkerResult('WORKER: rm -rf')).toBeNull();
  expect(parseWorkerResult('')).toBeNull();
  expect(parseWorkerResult('WORKER: exists\nWORKER: started\n')).toBe('started');
  expect(parseWorkerResult('WORKER: started\nWORKER: no-dir')).toBe('no-dir');
  expect(parseWorkerResult('WORKER: no-tmux\n')).toBe('no-tmux');
  // The last valid line wins over a later invalid one, and nothing is trimmed into a match.
  expect(parseWorkerResult('WORKER: started\nWORKER: bogus\n')).toBe('started');
  expect(parseWorkerResult(' WORKER: started')).toBeNull();
  expect(parseWorkerResult('WORKER: started\r\n')).toBeNull();
  expect(parseWorkerResult('WORKER: toString')).toBeNull();
  expect(parseWorkerResult(undefined)).toBeNull();
  expect(parseWorkerResult(null)).toBeNull();
});
