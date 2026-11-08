import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentSampler, readAgentMarks, LOCAL_BOX_ID } from '../src/server/localAgent.js';
import { sampleOf } from '../src/server/healthHistory.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-localagent-'));
}

test('LOCAL_BOX_ID matches the client pane id', () => {
  expect(LOCAL_BOX_ID).toBe('__local__');
});

test('readAgentMarks parses a valid marker through the probe allowlist', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'local'), 'local:working:1722600000\n');
  expect(await readAgentMarks(home)).toEqual({ local: { state: 'working', cause: 'prompt', ts: 1722600000 } });
});

test('readAgentMarks returns null for a missing dir, malformed content, and bad state', async () => {
  expect(await readAgentMarks(tmpHome())).toBeNull();

  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'a'), 'not a marker at all');
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'b'), 'local:reticulating:1722600000');
  expect(await readAgentMarks(home)).toBeNull();
});

test('readAgentMarks caps an oversized marker at 200 bytes (same as the on-box probe)', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  // 300 bytes of junk: the 200-byte cap truncates it and the parser drops it.
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'big'), 'x'.repeat(300));
  expect(await readAgentMarks(home)).toBeNull();
});

// The 200-byte cap above is applied to the bytes AFTER the whole file has been
// read, so it bounds what is parsed, not what is read. A stat() guard bounds
// the read itself: only regular files, only small ones. It follows symlinks,
// matching the on-box probe's `[ -f "$f" ]`, and keeps readFile away from
// entries it would block on or slurp.
test('readAgentMarks skips directory and oversized entries, keeping the valid marker', async () => {
  const home = tmpHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'local'), 'local:working:1722600000\n');
  fs.writeFileSync(path.join(dir, 'huge'), 'x'.repeat(2000)); // past the read guard
  fs.mkdirSync(path.join(dir, 'subdir'));                     // not a regular file
  expect(await readAgentMarks(home)).toEqual({ local: { state: 'working', cause: 'prompt', ts: 1722600000 } });
});

test('sample() reads tmux sessions via the shared STATUS_FMT parser', async () => {
  const home = tmpHome();
  const calls = [];
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async (args) => {
      calls.push(args);
      return { code: 0, stdout: 'local:1:0:1722600000:claude\n' };
    },
  });
  const s = await sampler.sample();
  expect(calls[0][0]).toBe('ls');
  expect(s.reachable).toBe(true);
  expect(s.tmux).toBe(true);
  expect(s.sessions).toEqual([{ name: 'local', windows: 1, attached: false, activity: 1722600000, paneCmd: 'claude' }]);
});

test('sample() degrades to no sessions when tmux is absent or has no server', async () => {
  const noServer = createLocalAgentSampler({
    home: tmpHome(),
    runTmux: async () => ({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-0/default\n' }),
  });
  expect(await noServer.sample()).toMatchObject({ reachable: true, sessions: [] });

  const staleSocket = createLocalAgentSampler({
    home: tmpHome(),
    runTmux: async () => ({ code: 1, stdout: '', stderr: 'error connecting to /tmp/tmux-0/default (No such file or directory)\n' }),
  });
  expect(await staleSocket.sample()).toMatchObject({ reachable: true, sessions: [] });

  const absent = createLocalAgentSampler({ home: tmpHome(), runTmux: async () => ({ code: 1, stdout: '', stderr: '', errno: 'ENOENT' }) });
  expect(await absent.sample()).toMatchObject({ reachable: true, sessions: [] });

  const throwing = createLocalAgentSampler({
    home: tmpHome(),
    runTmux: async () => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }); },
  });
  expect(await throwing.sample()).toMatchObject({ reachable: true, sessions: [] });
});

test('sample(): only tmux\'s own no-server wording is an empty listing; a denied socket is unknown', async () => {
  const make = (stderr) => createLocalAgentSampler({ home: '/nonexistent', runTmux: async () => ({ code: 1, stdout: '', stderr }) });
  // tmux says `no server running` for a missing server and for a refused connection alike.
  expect((await make('no server running on /tmp/tmux-1000/default').sample()).sessions).toEqual([]);
  expect((await make('error connecting to /tmp/tmux-1000/default (No such file or directory)').sample()).sessions).toEqual([]);
  expect((await make('error connecting to /tmp/tmux-1000/default (Permission denied)').sample()).sessions).toBeUndefined();
});

// Any OTHER failure is "listing unknown", not "no sessions": an empty list
// would read as every session having exited (latching agent-done) and would
// prune the Host Shell's seen watermark.
test('sample() leaves sessions out when tmux ls fails for any other reason', async () => {
  const cases = [
    async () => ({ code: 1, stdout: '', stderr: '' }),                                 // timeout/kill: no message
    async () => ({ code: 1, stdout: '', stderr: 'server exited unexpectedly\n' }),
    async () => ({ code: 1, stdout: '', stderr: 'error creating /tmp/tmux-0 (Permission denied)\n' }),
    async () => { throw new Error('boom'); },
  ];
  for (const runTmux of cases) {
    const s = await createLocalAgentSampler({ home: tmpHome(), runTmux }).sample();
    expect(s.reachable).toBe(true);
    expect('sessions' in s).toBe(false);
    expect('tmux' in s).toBe(false);
    // ...and downstream that is "not observed": sampleOf sets no agents map.
    expect('agents' in sampleOf(s, 1, { sessionName: 'local' })).toBe(false);
  }
});

test('the sample shape drives sampleOf exactly like a box probe result', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'local'), 'local:working:1722600000');
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async () => ({ code: 0, stdout: 'local:1:0:1722600000:claude\n' }),
  });
  const sample = sampleOf(await sampler.sample(), 123, { sessionName: 'local' });
  expect(sample.up).toBe(true);
  expect(sample.agentPresent).toBe(true);
  expect(sample.agent).toBe('working');
  expect(sample.agentAttached).toBe(false);
});

function withReporter(home) {
  fs.mkdirSync(path.join(home, '.tmuxifier-osc'));
  fs.writeFileSync(path.join(home, '.tmuxifier-osc', 'reporter.py'), '# stub\n');
}

test('sample() runs the OSC sweep once, before the tmux listing, when the reporter is installed', async () => {
  const home = tmpHome();
  withReporter(home);
  const order = [];
  const sampler = createLocalAgentSampler({
    home,
    runSweep: async (h) => { order.push(['sweep', h]); },
    runTmux: async () => { order.push(['tmux']); return { code: 0, stdout: '' }; },
  });
  await sampler.sample();
  expect(order).toEqual([['sweep', home], ['tmux']]);
});

test('sample() never runs the OSC sweep when the reporter is absent', async () => {
  let swept = 0;
  const sampler = createLocalAgentSampler({
    home: tmpHome(),
    runSweep: async () => { swept++; },
    runTmux: async () => ({ code: 0, stdout: 'local:1:0:1722600000:claude\n' }),
  });
  await sampler.sample();
  expect(swept).toBe(0);
});

test('a rejecting or synchronously throwing runSweep leaves the sample unchanged', async () => {
  const home = tmpHome();
  withReporter(home);
  const runTmux = async () => ({ code: 0, stdout: 'local:1:0:1722600000:claude\n' });
  const base = await createLocalAgentSampler({ home: tmpHome(), runTmux }).sample();
  for (const runSweep of [async () => { throw new Error('boom'); }, () => { throw new Error('sync'); }]) {
    expect(await createLocalAgentSampler({ home, runTmux, runSweep }).sample()).toEqual(base);
  }
});
