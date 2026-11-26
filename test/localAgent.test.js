import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalAgentSampler, readAgentMarks, readMarks, LOCAL_BOX_ID } from '../src/server/localAgent.js';
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
    expect('agents' in sampleOf(s, 1)).toBe(false);
  }
});

test('the sample shape drives sampleOf like a box probe result', async () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'local'), 'local:working:1722600000');
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async (args) => (args[0] === 'list-panes'
      ? { code: 0, stdout: '__PANE__ local:@0:%3:0:1:0:claude\n' }
      : { code: 0, stdout: 'local:1:0:1722600000:claude\n' }),
  });
  const raw = await sampler.sample();
  const sample = sampleOf(raw, 123);
  expect(sample.up).toBe(true);
  // The sampler does not list windows, and a pane is placed through its
  // window row, so no pane gets an entry from it alone.
  expect(sample.agents).toEqual({});
  // Given its session's window row, the session-wide marker speaks for the pane.
  raw.sessions = raw.sessions.map((x) => ({ ...x, windowList: [{ id: '@0', index: 0, name: 'shell', active: true }] }));
  expect(sampleOf(raw, 123).agents['%3']).toMatchObject({ session: 'local', agent: 'claude', state: 'working', attached: false, focused: true });
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
  expect(order[0]).toEqual(['sweep', home]);
  expect(order.slice(1).every(([k]) => k === 'tmux')).toBe(true);
  expect(order.filter(([k]) => k === 'sweep')).toHaveLength(1);
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

test('sample() folds Host Shell split panes and ignores a closed pane', async () => {
  const home = tmpHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'local%1'), 'local:working:100:prompt:%1\n');
  fs.writeFileSync(path.join(dir, 'local%2'), 'local:ready:200:stop:%2\n');
  fs.writeFileSync(path.join(dir, 'local%9'), 'local:blocked:300:question:%9\n');
  const sampler = createLocalAgentSampler({
    home,
    runTmux: async (args) => (args[0] === 'list-panes'
      ? { code: 0, stdout: '__PANE__ local:@0:%1:1:1:0:claude\n__PANE__ local:@0:%2:2:0:0:claude\n' }
      : { code: 0, stdout: 'local:1:0:1722600000:claude\n' }),
  });
  expect((await sampler.sample()).agentMarks.local).toEqual({ state: 'working', cause: 'prompt', ts: 100 });
});

// The per-pane reading beside the per-session one: the same files and the same
// pane listing, parsed by the pane parsers.
function localHome(files) {
  const home = tmpHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return home;
}
const tmuxStub = (paneOut, lsOut = 'local:1:0:1722600000:claude\n') => async (args) => (args[0] === 'list-panes'
  ? { code: 0, stdout: paneOut }
  : { code: 0, stdout: lsOut });

test('sample() returns panes and paneMarks beside agentMarks for a per-pane marker', async () => {
  const home = localHome({ 'local%4': 'local:working:1722600005:prompt:%4\n' });
  const sampler = createLocalAgentSampler({
    home,
    runTmux: tmuxStub('__PANE__ local:@0:%4:1:1:0:claude\n__PANE__ local:@0:%5:2:0:0:zsh\n'),
  });
  const s = await sampler.sample();
  expect(s.panes).toEqual([
    { session: 'local', windowId: '@0', pane: '%4', index: 1, active: true, zoomed: false, cmd: 'claude' },
    { session: 'local', windowId: '@0', pane: '%5', index: 2, active: false, zoomed: false, cmd: 'zsh' },
  ]);
  expect({ ...s.paneMarks }).toEqual({ '%4': { session: 'local', state: 'working', cause: 'prompt', ts: 1722600005 } });
  expect(s.agentMarks.local).toEqual({ state: 'working', cause: 'prompt', ts: 1722600005 });
});

test('sample() applies a session-wide marker to the Host Shell\'s agent panes with no marker of their own', async () => {
  const home = localHome({ local: 'local:blocked:1722600009:question\n' });
  const sampler = createLocalAgentSampler({
    home,
    runTmux: tmuxStub('__PANE__ local:@0:%1:1:1:0:codex\n__PANE__ local:@0:%2:2:0:0:zsh\n'),
  });
  expect({ ...(await sampler.sample()).paneMarks }).toEqual({ '%1': { session: 'local', state: 'blocked', cause: 'question', ts: 1722600009 } });
});

test('sample() reports an empty pane list for an empty tmux, and none when the pane listing cannot be trusted', async () => {
  const noServer = createLocalAgentSampler({
    home: tmpHome(),
    runTmux: async () => ({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-0/default\n' }),
  });
  expect((await noServer.sample()).panes).toEqual([]);
  // Sessions exist but list-panes failed or came back without rows: unknown, not empty.
  const failed = createLocalAgentSampler({
    home: tmpHome(),
    runTmux: async (args) => (args[0] === 'list-panes' ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: 'local:1:0:1722600000:claude\n' }),
  });
  const s = await failed.sample();
  expect(s.sessions).toHaveLength(1);
  expect('panes' in s).toBe(false);
  expect('paneMarks' in s).toBe(false);
  // A listing cut off at the row cap is not the whole box either.
  const capped = Array.from({ length: 400 }, (_, i) => `__PANE__ local:@0:%${i}:${i}:0:0:zsh`).join('\n');
  expect('panes' in await createLocalAgentSampler({ home: tmpHome(), runTmux: tmuxStub(capped) }).sample()).toBe(false);
});

test('sample() carries no paneMarks without a usable marker', async () => {
  const sampler = createLocalAgentSampler({ home: tmpHome(), runTmux: tmuxStub('__PANE__ local:@0:%1:1:1:0:claude\n') });
  const s = await sampler.sample();
  expect(s.panes).toHaveLength(1);
  expect('paneMarks' in s).toBe(false);
  expect('agentMarks' in s).toBe(false);
});

test('readMarks returns both readings from one read of the marker directory', async () => {
  const home = localHome({ 'local%1': 'local:ready:1722600001:stop:%1\n' });
  const rows = ['__PANE__ local:@0:%1:1:1:0:claude'];
  const both = await readMarks(home, rows);
  expect(both.agentMarks).toEqual({ local: { state: 'ready', cause: 'stop', ts: 1722600001 } });
  expect({ ...both.paneMarks }).toEqual({ '%1': { session: 'local', state: 'ready', cause: 'stop', ts: 1722600001 } });
  expect(await readMarks(tmpHome())).toBeNull();
  expect(await readAgentMarks(home, rows)).toEqual(both.agentMarks);
});
