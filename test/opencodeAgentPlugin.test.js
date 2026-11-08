import { test, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The writer half of the OpenCode reporter: sweep, marker files, the
// process-wide singleton and the V2 entry point (spec §4.1 "Process-wide
// singleton with unconditional hand-over", "Attribution and writing",
// "Sweep"). Real files under a temp HOME; tmux is either an injected
// listPanes or a fake `tmux` script on PATH (the real execFile transport).

const ASSET = '../src/server/assets/tmuxifier-opencode-agent.js';
const KEY = Symbol.for('tmuxifier.opencode-agent');
const TRACE = fileURLToPath(new URL('./fixtures/opencode-event-trace.jsonl', import.meta.url));
const traceEvent = (n) => JSON.parse(readFileSync(TRACE, 'utf8').split('\n')[n - 1]).event;

const tmps = [];
function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), 'oc-plugin-'));
  tmps.push(d);
  return d;
}
afterEach(async () => {
  const core = globalThis[KEY];
  if (core) {
    try { core.abort(); } catch { /* best effort */ }
    delete globalThis[KEY];
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const row = (session, cmd, p, wa = '1', pa = '1') => `${session}\t${wa}\t${pa}\t${cmd}\t${p}\n`;
const markerDir = (home) => path.join(home, '.tmuxifier-agent');
const marker = (home, name) => path.join(markerDir(home), name);
const read = (home, name) => readFileSync(marker(home, name), 'utf8');
const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// A core over a temp HOME whose tmux listing and clock the test drives.
async function rig(opts = {}) {
  const { createCore } = await import(ASSET);
  const home = tmp();
  const state = { panes: '', t: 1000, calls: 0 };
  const core = createCore({
    home,
    listPanes: async () => { state.calls++; return state.panes; },
    now: () => state.t,
    paneCacheMs: 0,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    ...opts,
  });
  return { core, home, state };
}

let evN = 0;
const ev = (type, createdSec, data, dir) => ({
  id: `t${++evN}`, type, ...(createdSec == null ? {} : { created: createdSec * 1000 }), data, ...(dir ? { location: { directory: dir } } : {}),
});

// An OpenCode ctx whose event stream is fed by push() and ends on abort.
function fakeCtx() {
  const queue = [];
  let wake = null;
  const ctx = {
    signal: null,
    push(e) { queue.push(e); if (wake) wake(); },
    event: {
      async *subscribe({ signal }) {
        ctx.signal = signal;
        while (!signal.aborted) {
          if (queue.length) { yield queue.shift(); continue; }
          await new Promise((r) => { wake = r; signal.addEventListener('abort', r, { once: true }); });
          wake = null;
        }
      },
    },
  };
  return ctx;
}

// A fake `tmux` on PATH printing $TMUXIFIER_FAKE_PANES, and HOME stubbed, so
// the default export's own defaults (os.homedir(), defaultListPanes) are used.
function fakeTmuxEnv() {
  const home = tmp();
  const bin = tmp();
  const panesFile = path.join(bin, 'panes.txt');
  writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\n[ "$1 $2 $3" = "list-panes -a -F" ] || exit 2\ncat "$TMUXIFIER_FAKE_PANES"\n');
  chmodSync(path.join(bin, 'tmux'), 0o755);
  vi.stubEnv('HOME', home);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  vi.stubEnv('TMUXIFIER_FAKE_PANES', panesFile);
  return { home, setPanes: (text) => writeFileSync(panesFile, text) };
}

test('the asset imports under plain Node with no side effects and exports the V2 default shape', async () => {
  const mod = await import(ASSET);
  expect(mod.default.id).toBe('tmuxifier-agent'); expect(typeof mod.default.setup).toBe('function');
  expect(globalThis[Symbol.for('tmuxifier.opencode-agent')]).toBeUndefined();
  expect(mod.GLOBAL_KEY).toBe(KEY);
});

test('sweep writes ready/start for a fresh opencode pane and nothing for a claude pane', async () => {
  const { core, home, state } = await rig();
  state.panes = row('web', 'opencode', '/home/user/proj') + row('dev', 'claude', '/x');
  await core.sweep();
  expect(read(home, 'web')).toBe('web:ready:1000:start\n');
  expect(existsSync(marker(home, 'dev'))).toBe(false);
  expect(readdirSync(markerDir(home))).toEqual(['web']); // no temp file left behind
  expect(core.written.get('web')).toBe('web:ready:1000:start\n');
  expect(core.since.get('web')).toBe(1000);
});

test('a state change rewrites the marker atomically with the session\'s ts; an unchanged fold does not rewrite', async () => {
  const { core, home, state } = await rig();
  state.t = 1794098600; // the pane appeared before the recorded session
  state.panes = row('web', 'opencode', '/home/user/proj');
  await core.sweep();
  const first = statSync(marker(home, 'web'));
  for (const n of [15, 16, 17, 18]) {
    const e = traceEvent(n);
    if (e) await core.handle(e);
  }
  expect(read(home, 'web')).toBe('web:working:1794098652:prompt\n');
  const second = statSync(marker(home, 'web'));
  expect(second.ino).not.toBe(first.ino); // a fresh file renamed into place, not an in-place edit
  expect((second.mode & 0o777).toString(8)).toBe((0o644 & ~process.umask()).toString(8));
  await flush(20);
  state.t += 60;
  await core.sweep();
  const third = statSync(marker(home, 'web'));
  expect(third.ino).toBe(second.ino);
  expect(third.mtimeMs).toBe(second.mtimeMs);
  expect(readdirSync(markerDir(home))).toEqual(['web']);
});

test('a tmux session whose pane stopped being opencode gets its marker deleted only if the content is still ours', async () => {
  const { core, home, state } = await rig();
  state.panes = row('web', 'opencode', '/home/user/proj');
  await core.sweep();
  writeFileSync(marker(home, 'web'), 'web:blocked:1:permission\n'); // the Claude hook took over
  state.panes = row('web', 'zsh', '/home/user/proj');
  await core.sweep();
  expect(read(home, 'web')).toBe('web:blocked:1:permission\n');
  expect(core.written.has('web')).toBe(false);

  const b = await rig();
  b.state.panes = row('web', 'opencode', '/home/user/proj');
  await b.core.sweep();
  b.state.panes = row('web', 'zsh', '/home/user/proj');
  await b.core.sweep();
  expect(existsSync(marker(b.home, 'web'))).toBe(false);
  expect(b.core.written.has('web')).toBe(false);
  // A killed tmux session (gone from the listing) is deleted the same way.
  b.state.panes = row('web', 'opencode', '/home/user/proj');
  await b.core.sweep();
  b.state.panes = '';
  await b.core.sweep();
  expect(existsSync(marker(b.home, 'web'))).toBe(false);
});

test('listPanes failing (null), hanging past the timeout, or returning garbage leaves no marker and no throw', async () => {
  const { defaultListPanes } = await import(ASSET);
  const err = vi.spyOn(console, 'error');
  const log = vi.spyOn(console, 'log');
  for (const listPanes of [
    async () => null,
    async () => { throw new Error('boom'); },
    () => { throw new Error('sync boom'); },
    async () => 42,
    async () => '\x00garbage\nweb\t1\t1\topencode\n\t\t\t\t\n',
  ]) {
    const { core, home } = await rig({ listPanes });
    await expect(core.sweep()).resolves.toBeUndefined();
    expect(existsSync(markerDir(home))).toBe(false);
  }
  // Hanging: the real transport against a tmux that never answers.
  const bin = tmp();
  const hang = path.join(bin, 'tmux');
  writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(hang, 0o755);
  const { core, home } = await rig({ listPanes: () => defaultListPanes({ file: hang, timeout: 200 }) });
  const t0 = Date.now();
  await core.sweep();
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(existsSync(markerDir(home))).toBe(false);

  // A failing listing never deletes what is already written: inert, not empty.
  const r = await rig();
  r.state.panes = row('web', 'opencode', '/p');
  await r.core.sweep();
  r.state.panes = null;
  await r.core.sweep();
  expect(read(r.home, 'web')).toBe('web:ready:1000:start\n');
  expect(r.core.since.get('web')).toBe(1000);

  // An unwritable HOME (a regular file) swallows the fs error.
  const file = path.join(tmp(), 'not-a-dir');
  writeFileSync(file, '');
  const f = await rig({ home: file });
  f.state.panes = row('web', 'opencode', '/p');
  await expect(f.core.sweep()).resolves.toBeUndefined();
  expect(f.core.written.has('web')).toBe(false); // a failed write is retried next sweep

  expect(err).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
});

test('defaultListPanes runs tmux list-panes -a -F PANE_FORMAT and resolves null on ENOENT, timeout or a non-zero exit', async () => {
  const { defaultListPanes, PANE_FORMAT } = await import(ASSET);
  const bin = tmp();
  const script = (name, body) => {
    const p = path.join(bin, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const echo = script('echo', 'printf "%s|" "$@"');
  expect(await defaultListPanes({ file: echo })).toBe(`list-panes|-a|-F|${PANE_FORMAT}|`);
  expect(await defaultListPanes({ file: path.join(bin, 'missing') })).toBeNull();
  expect(await defaultListPanes({ file: script('fail', 'echo partial; exit 1') })).toBeNull();
  expect(await defaultListPanes({ file: script('hang', 'exec sleep 30'), timeout: 200 })).toBeNull();
  // The default looks tmux up on PATH.
  const env = fakeTmuxEnv();
  env.setPanes(row('web', 'opencode', '/p'));
  expect(await defaultListPanes()).toBe(row('web', 'opencode', '/p'));
});

test('the pane listing is cached for a second', async () => {
  const { core, state } = await rig({ paneCacheMs: undefined });
  let clock = 5_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  state.panes = row('web', 'opencode', '/p');
  await core.sweep();
  await core.sweep();
  expect(state.calls).toBe(1);
  clock += 1001;
  await core.sweep();
  expect(state.calls).toBe(2);
});

test('since: a session finished before the pane appeared reads ready/start; a new turn after it reads its own state', async () => {
  const { core, home, state } = await rig();
  await core.handle(ev('session.created', 100, { sessionID: 'ses_a' }, '/proj'));
  await core.handle(ev('session.execution.started', 110, { sessionID: 'ses_a' }));
  await core.handle(ev('session.execution.succeeded', 120, { sessionID: 'ses_a' }));
  state.t = 500;
  state.panes = row('web', 'opencode', '/proj');
  await core.sweep();
  expect(read(home, 'web')).toBe('web:ready:500:start\n');
  await core.handle(ev('session.execution.started', 600, { sessionID: 'ses_a' }));
  expect(read(home, 'web')).toBe('web:working:600:prompt\n');
  await core.handle(ev('session.execution.succeeded', 650, { sessionID: 'ses_a' }));
  expect(read(home, 'web')).toBe('web:ready:650:stop\n');
});

test('since tracks hosting: a window switch keeps since and deletes the marker; switching back shows a block raised before', async () => {
  const { core, home, state } = await rig();
  await core.handle(ev('session.created', 900, { sessionID: 'ses_a' }, '/proj'));
  state.t = 1000;
  state.panes = row('web', 'opencode', '/proj');
  await core.sweep();
  await core.handle(ev('session.execution.started', 1100, { sessionID: 'ses_a' }));
  await core.handle(ev('permission.asked', 1200, { id: 'per_1', sessionID: 'ses_a' }, '/proj'));
  expect(read(home, 'web')).toBe('web:blocked:1200:permission\n');

  // Switch to a zsh window: the opencode pane is still there, in a background window.
  state.t = 1300;
  state.panes = row('web', 'opencode', '/proj', '0', '1') + row('web', 'zsh', '/proj', '1', '1');
  await core.sweep();
  expect(existsSync(marker(home, 'web'))).toBe(false);
  expect(core.since.get('web')).toBe(1000);

  // Back to the OpenCode window much later: same since, the block is still a candidate.
  state.t = 5000;
  state.panes = row('web', 'opencode', '/proj', '1', '1') + row('web', 'zsh', '/proj', '0', '1');
  await core.sweep();
  expect(core.since.get('web')).toBe(1000);
  expect(read(home, 'web')).toBe('web:blocked:1200:permission\n');
});

test('since tracks hosting: a TUI exit removes since, so a relaunch excludes the old finished sessions', async () => {
  const { core, home, state } = await rig();
  await core.handle(ev('session.created', 900, { sessionID: 'ses_a' }, '/proj'));
  state.t = 1000;
  state.panes = row('web', 'opencode', '/proj');
  await core.sweep();
  await core.handle(ev('session.execution.started', 1100, { sessionID: 'ses_a' }));
  await core.handle(ev('session.execution.succeeded', 1200, { sessionID: 'ses_a' }));
  expect(read(home, 'web')).toBe('web:ready:1200:stop\n');

  state.t = 1300;
  state.panes = row('web', 'zsh', '/proj'); // no opencode pane anywhere in web
  await core.sweep();
  expect(core.since.has('web')).toBe(false);
  expect(existsSync(marker(home, 'web'))).toBe(false);

  state.t = 2000;
  state.panes = row('web', 'opencode', '/proj');
  await core.sweep();
  expect(core.since.get('web')).toBe(2000);
  expect(read(home, 'web')).toBe('web:ready:2000:start\n');
});

test('session names are sanitized in the filename but exact in the content', async () => {
  const { core, home, state } = await rig();
  state.panes = row('my session/x', 'opencode', '/p') + row('..', 'opencode', '/p');
  await core.sweep();
  expect(readFileSync(marker(home, 'my_session_x'), 'utf8')).toBe('my session/x:ready:1000:start\n');
  expect(readdirSync(markerDir(home))).toEqual(['my_session_x']); // `..` never escapes the directory
  const { safeName } = await import(ASSET);
  expect(safeName('a b/c:d.e-f_g')).toBe('a_b_c_d.e-f_g');
});

test('state changes coalesce: one sweep in flight, at most one rerun after it; an unchanged state sweeps nothing', async () => {
  let release = null;
  let calls = 0;
  const panes = row('web', 'opencode', '/proj');
  const { core, home } = await rig({ listPanes: async () => { calls++; await new Promise((r) => { release = r; }); return panes; } });
  core.reducer.apply(ev('session.created', 900, { sessionID: 'ses_a' }, '/proj'));
  const p1 = core.handle(ev('session.execution.started', 1100, { sessionID: 'ses_a' }));
  const p2 = core.handle(ev('permission.asked', 1200, { id: 'per_1', sessionID: 'ses_a' }, '/proj'));
  const p3 = core.handle(ev('permission.replied', 1300, { requestID: 'per_1', sessionID: 'ses_a' }, '/proj'));
  await flush(5);
  expect(calls).toBe(1);
  release();
  await flush(5);
  expect(calls).toBe(2); // one rerun for all the changes made meanwhile
  release();
  await Promise.all([p1, p2, p3]);
  expect(calls).toBe(2);
  expect(read(home, 'web')).toBe('web:working:1300:unblock\n');
  // An event that changes no state starts no sweep.
  await core.handle(ev('session.step.started', 1400, { sessionID: 'ses_a' }));
  expect(calls).toBe(2);
});

test('abort stops the timer and the subscription, keeps the markers, and an in-flight sweep writes nothing', async () => {
  let release;
  const timers = [];
  const cleared = [];
  const { core, home, state } = await rig({
    setInterval: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearInterval: (t) => cleared.push(t),
  });
  state.panes = row('web', 'opencode', '/proj');
  const ctx = fakeCtx();
  const done = core.attach(ctx);
  await flush();
  expect(read(home, 'web')).toBe('web:ready:1000:start\n');
  expect(timers).toHaveLength(1);
  expect(timers[0].ms).toBe(15000);

  const b = await rig({ listPanes: () => new Promise((r) => { release = () => r(row('dev', 'opencode', '/proj')); }) });
  const pending = b.core.sweep();
  core.abort();
  b.core.abort();
  release();
  await pending;
  expect(existsSync(markerDir(b.home))).toBe(false);

  await done; // the event loop ended
  expect(ctx.signal.aborted).toBe(true);
  expect(cleared).toEqual([timers[0]]);
  expect(read(home, 'web')).toBe('web:ready:1000:start\n'); // abort never deletes
  await core.sweep();
  ctx.push(ev('session.created', 2000, { sessionID: 'ses_z' }, '/proj'));
  await flush();
  expect(read(home, 'web')).toBe('web:ready:1000:start\n');
});

test('the sweep timer is unref\'d so the plugin never keeps the server alive', async () => {
  const unref = vi.fn();
  let tick;
  const { core, home, state } = await rig({ setInterval: (fn) => { tick = fn; return { unref }; } });
  state.panes = row('web', 'opencode', '/proj');
  const ctx = fakeCtx();
  core.attach(ctx);
  expect(unref).toHaveBeenCalledTimes(1);
  await flush();
  // The timer's tick is a sweep.
  state.t = 2000;
  state.panes = row('web', 'zsh', '/proj');
  tick();
  await flush();
  expect(existsSync(marker(home, 'web'))).toBe(false);
  core.abort();
});

test('setup twice hands over: the second core inherits written/since, the first subscription and timer are aborted, the first cleanup is a no-op', async () => {
  const mod = await import(ASSET);
  const env = fakeTmuxEnv();
  env.setPanes(row('web', 'opencode', '/proj'));
  const started = [];
  const stopped = [];
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms) => { const t = realSet(fn, ms); if (ms === 15000) started.push(t); return t; });
  vi.spyOn(globalThis, 'clearInterval').mockImplementation((t) => { if (started.includes(t)) stopped.push(t); return realClear(t); });

  const ctx1 = fakeCtx();
  const cleanup1 = await mod.default.setup(ctx1);
  const core1 = globalThis[KEY];
  await vi.waitFor(() => expect(existsSync(marker(env.home, 'web'))).toBe(true));
  const first = statSync(marker(env.home, 'web'));
  expect(read(env.home, 'web')).toMatch(/^web:ready:\d+:start\n$/);

  const ctx2 = fakeCtx();
  const cleanup2 = await mod.default.setup(ctx2);
  const core2 = globalThis[KEY];
  expect(core2).not.toBe(core1);
  expect(core2.written).toBe(core1.written);
  expect(core2.since).toBe(core1.since);
  expect(ctx1.signal.aborted).toBe(true);
  expect(ctx2.signal.aborted).toBe(false);
  expect(stopped).toEqual([started[0]]);
  await flush(100);
  expect(statSync(marker(env.home, 'web')).ino).toBe(first.ino); // inherited memory: no rewrite

  // The aborted subscription is gone: its events go nowhere.
  ctx1.push(ev('session.created', null, { sessionID: 'ses_a' }, '/proj'));
  ctx1.push(ev('session.execution.started', null, { sessionID: 'ses_a' }));
  await flush(100);
  expect(read(env.home, 'web')).toMatch(/:start\n$/);
  ctx2.push(ev('session.created', null, { sessionID: 'ses_b' }, '/proj'));
  ctx2.push(ev('session.execution.started', null, { sessionID: 'ses_b' }));
  await vi.waitFor(() => expect(read(env.home, 'web')).toMatch(/^web:working:\d+:prompt\n$/));

  await cleanup1();
  expect(existsSync(marker(env.home, 'web'))).toBe(true);
  expect(globalThis[KEY]).toBe(core2);
  await cleanup2();
  expect(existsSync(marker(env.home, 'web'))).toBe(false);
  expect(globalThis[KEY]).toBeUndefined();
  expect(ctx2.signal.aborted).toBe(true);
  expect(stopped).toEqual([started[0], started[1]]);
});

test('cleanup deletes only markers whose content still equals the last write', async () => {
  const mod = await import(ASSET);
  const env = fakeTmuxEnv();
  env.setPanes(row('web', 'opencode', '/proj') + row('dev', 'opencode', '/other'));
  const cleanup = await mod.default.setup(fakeCtx());
  await vi.waitFor(() => {
    expect(existsSync(marker(env.home, 'web'))).toBe(true);
    expect(existsSync(marker(env.home, 'dev'))).toBe(true);
  });
  writeFileSync(marker(env.home, 'dev'), 'dev:working:1:prompt\n'); // the Claude hook's now
  await cleanup();
  expect(existsSync(marker(env.home, 'web'))).toBe(false);
  expect(read(env.home, 'dev')).toBe('dev:working:1:prompt\n');
  expect(globalThis[KEY]).toBeUndefined();
});

test('nothing reaches OpenCode: a ctx without an event stream, or a throwing one, still sets up and cleans up', async () => {
  const mod = await import(ASSET);
  fakeTmuxEnv();
  const err = vi.spyOn(console, 'error');
  for (const ctx of [undefined, {}, { event: { subscribe() { throw new Error('nope'); } } },
    { event: { async *subscribe() { throw new Error('later'); } } }]) {
    const cleanup = await mod.default.setup(ctx);
    expect(typeof cleanup).toBe('function');
    await flush(20);
    await expect(cleanup()).resolves.toBeUndefined();
  }
  // A foreign or older object under the key is replaced, never trusted to have abort().
  globalThis[KEY] = { written: 'not a map' };
  const cleanup = await mod.default.setup(fakeCtx());
  expect(globalThis[KEY].written).toBeInstanceOf(Map);
  await cleanup();
  expect(err).not.toHaveBeenCalled();
  // The debug switch is the one place the plugin speaks.
  vi.stubEnv('TMUXIFIER_OPENCODE_DEBUG', '1');
  const c2 = await mod.default.setup({});
  await flush(20);
  await c2();
  expect(err).toHaveBeenCalled();
});
