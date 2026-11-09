import { test, expect, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWatchScript, WATCH_REMOTE, createAgentWatch, createLocalMarkWatch,
} from '../src/server/agentWatch.js';

// The watch script is exercised for real under /bin/sh against a temp HOME —
// the same text the server sends as the ssh remote command. Only the manager's
// scheduling (throttle, restart, staleness) is driven through an injected
// stream, because it needs a clock the test controls.

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best-effort */ } }
});

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tmuxifier-watch-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Run the real script; collect its stdout lines as they arrive.
function runScript(home, opts) {
  const child = spawn('/bin/sh', ['-c', buildWatchScript(opts)], {
    env: { HOME: home, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const parts = buf.split('\n');
    buf = parts.pop();
    lines.push(...parts);
  });
  cleanups.push(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return { child, lines };
}

const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
};
const count = (lines, what) => lines.filter((l) => l === what).length;

test('the script reports once at start, then only when a marker changes', async () => {
  const home = tempHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'main'), 'main:working:100:prompt\n');
  const { lines } = runScript(home, { beatTicks: 1000 });
  expect(await until(() => count(lines, 'c') === 1)).toBe(true);
  // Unchanged content: several ticks pass and nothing more is said.
  await new Promise((r) => setTimeout(r, 2300));
  expect(count(lines, 'c')).toBe(1);
  fs.writeFileSync(path.join(dir, 'main'), 'main:blocked:101:permission\n');
  expect(await until(() => count(lines, 'c') === 2)).toBe(true);
  // A second session's marker appearing is a change too, and so is its removal.
  fs.writeFileSync(path.join(dir, 'other'), 'other:ready:102:stop\n');
  expect(await until(() => count(lines, 'c') === 3)).toBe(true);
  fs.rmSync(path.join(dir, 'other'));
  expect(await until(() => count(lines, 'c') === 4)).toBe(true);
  expect(lines.every((l) => l === 'c' || l === 'h')).toBe(true);
}, 20000);

test('the script reports at start with no marker directory at all, and sees it appear', async () => {
  const home = tempHome();
  const { lines } = runScript(home, { beatTicks: 1000 });
  expect(await until(() => count(lines, 'c') === 1)).toBe(true);
  fs.mkdirSync(path.join(home, '.tmuxifier-agent'));
  fs.writeFileSync(path.join(home, '.tmuxifier-agent', 'main'), 'main:working:1:prompt\n');
  expect(await until(() => count(lines, 'c') === 2)).toBe(true);
}, 15000);

test('a FIFO or a directory beside the markers never stalls the script', async () => {
  const home = tempHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(path.join(dir, 'busy'), { recursive: true });
  execFileSync('mkfifo', [path.join(dir, 'trap')]);
  fs.writeFileSync(path.join(dir, 'main'), 'main:working:1:prompt\n');
  const { lines } = runScript(home, { beatTicks: 1000 });
  expect(await until(() => count(lines, 'c') === 1)).toBe(true);
  // Reading the FIFO would block forever; a later change still gets through.
  fs.writeFileSync(path.join(dir, 'main'), 'main:ready:2:stop\n');
  expect(await until(() => count(lines, 'c') === 2)).toBe(true);
  // Files under a subdirectory (busy tokens, block owners) are not markers.
  fs.writeFileSync(path.join(dir, 'busy', 'tok'), 'x');
  await new Promise((r) => setTimeout(r, 2300));
  expect(count(lines, 'c')).toBe(2);
}, 20000);

test('the script beats while idle and dies once nobody reads it', async () => {
  const home = tempHome();
  const { child, lines } = runScript(home, { beatTicks: 1 });
  expect(await until(() => count(lines, 'h') >= 2)).toBe(true);
  // The reader goes away (the ssh channel closing): the next beat is a write
  // to a closed pipe, which must end the loop rather than leave it resident.
  const exited = new Promise((r) => child.once('exit', r));
  child.stdout.destroy();
  const raced = await Promise.race([exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('alive'), 6000))]);
  expect(raced).toBe('exited');
}, 15000);

test('the script text carries no single quote, so it survives the remote wrapper', () => {
  expect(buildWatchScript()).not.toContain("'");
  expect(WATCH_REMOTE).toBe(`exec sh -c '${buildWatchScript()}'`);
  expect(() => buildWatchScript({ tickSec: '1; rm -rf /' })).toThrow();
  expect(() => buildWatchScript({ beatTicks: 0 })).toThrow();
});

// --- the manager ---------------------------------------------------------

function harness(opts = {}) {
  let t = 1_000_000;
  const timers = [];
  const streams = [];
  const changes = [];
  let gate = null; // when set, onChange waits on it
  const watch = createAgentWatch({
    spawnStream: (box, { onData }) => {
      let end;
      const s = { box, onData, killed: false, done: new Promise((r) => { end = r; }) };
      s.kill = () => { s.killed = true; end({ code: 137 }); };
      s.exit = (code = 0) => end({ code });
      streams.push(s);
      return s;
    },
    onChange: async (id) => { changes.push(id); if (gate) await gate; },
    now: () => t,
    setTimeoutFn: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimeoutFn: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    ...opts,
  });
  const advance = async (ms) => {
    t += ms;
    for (const h of [...timers]) {
      if (h.at <= t) { timers.splice(timers.indexOf(h), 1); h.fn(); }
    }
    await flush();
  };
  return {
    watch, streams, changes, advance,
    setGate: (g) => { gate = g; },
    live: () => streams.filter((s) => !s.killed),
  };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const up = { reachable: true };
const boxA = { id: 'a', host: 'ha', user: 'u' };
const boxB = { id: 'b', host: 'hb', user: 'u' };

test('sync starts one stream per reachable box and none for the rest', () => {
  const h = harness();
  h.watch.sync([boxA, boxB, { id: 'c', host: 'hc' }, { id: 'd', host: 'hd' }], {
    a: up, b: { reachable: false, needsAuth: true }, c: { reachable: false }, // d: never probed
  });
  expect(h.streams.map((s) => s.box.id)).toEqual(['a']);
  h.watch.sync([boxA, boxB], { a: up, b: up });
  expect(h.streams.map((s) => s.box.id)).toEqual(['a', 'b']); // a is not started twice
  expect(h.watch.size()).toBe(2);
});

test('sync stops the stream of a box that went away, went down, or was re-addressed', () => {
  const h = harness();
  h.watch.sync([boxA, boxB], { a: up, b: up });
  h.watch.sync([boxA, boxB], { a: up, b: { reachable: false } });
  expect(h.streams[1].killed).toBe(true);
  h.watch.sync([boxB], { b: up });
  expect(h.streams[0].killed).toBe(true);
  // Same id, new address: the old stream is talking to the wrong machine.
  const moved = { ...boxB, host: 'elsewhere' };
  const before = h.streams.length;
  h.watch.sync([moved], { b: up });
  expect(h.live().map((s) => s.box.host)).toEqual(['elsewhere']);
  expect(h.streams.length).toBe(before + 1);
});

test('a change line calls onChange with the box id; anything else is ignored', async () => {
  const h = harness();
  h.watch.sync([boxA], { a: up });
  const s = h.streams[0];
  s.onData('h\n', 'stdout');
  s.onData('c\n', 'stderr');           // stderr is never a report
  s.onData('__AGENT__ x\nrm -rf\n', 'stdout');
  await flush();
  expect(h.changes).toEqual([]);
  s.onData('c\n', 'stdout');
  await flush();
  expect(h.changes).toEqual(['a']);
});

test('a line split across chunks is reassembled; an endless line is dropped, not buffered', async () => {
  const h = harness();
  h.watch.sync([boxA], { a: up });
  const s = h.streams[0];
  s.onData('h\nc', 'stdout');
  await flush();
  expect(h.changes).toEqual([]);
  s.onData('\n', 'stdout');
  await flush();
  expect(h.changes).toEqual(['a']);
  await h.advance(5000);
  // 1 MB with no newline, then a genuine report: the junk must not have been
  // kept (it would have swallowed the `c`), nor counted as one.
  s.onData('x'.repeat(1024 * 1024), 'stdout');
  s.onData('\nc\n', 'stdout');
  await flush();
  expect(h.changes).toEqual(['a', 'a']);
});

test('a flood of change lines costs one probe at a time, at most one per second', async () => {
  const h = harness();
  h.watch.sync([boxA], { a: up });
  const s = h.streams[0];
  let release;
  h.setGate(new Promise((r) => { release = r; }));
  s.onData('c\n'.repeat(5000), 'stdout');
  await flush();
  expect(h.changes.length).toBe(1);     // one chunk, one probe
  s.onData('c\n', 'stdout');
  s.onData('c\n', 'stdout');
  await flush();
  expect(h.changes.length).toBe(1);     // still in flight: the rest is folded
  h.setGate(null);
  release();
  await flush();
  expect(h.changes.length).toBe(1);     // finished, but inside the 1 s gap
  await h.advance(999);
  expect(h.changes.length).toBe(1);
  await h.advance(1);
  expect(h.changes.length).toBe(2);     // the folded changes run once, late
  await h.advance(5000);
  expect(h.changes.length).toBe(2);     // and nothing is left over
});

test('a change that lands while the probe runs is never lost', async () => {
  const h = harness();
  h.watch.sync([boxA], { a: up });
  let release;
  h.setGate(new Promise((r) => { release = r; }));
  h.streams[0].onData('c\n', 'stdout');
  await flush();
  h.streams[0].onData('c\n', 'stdout'); // the probe may already have read the old marker
  h.setGate(null);
  release();
  await h.advance(1000);
  expect(h.changes).toEqual(['a', 'a']);
});

test('a stream that ends is restarted on the next sync', async () => {
  const h = harness();
  h.watch.sync([boxA], { a: up });
  await h.advance(120000);              // lived long enough to count as healthy
  h.streams[0].exit(255);
  await flush();
  expect(h.watch.size()).toBe(0);
  h.watch.sync([boxA], { a: up });
  expect(h.streams.length).toBe(2);
});

test('a stream that keeps dying at once backs off instead of respawning every sweep', async () => {
  const h = harness();
  const starts = () => h.streams.length;
  h.watch.sync([boxA], { a: up });
  h.streams[0].exit(127);               // no sh, no head: dies immediately
  await flush();
  h.watch.sync([boxA], { a: up });
  expect(starts()).toBe(1);             // inside the first 30 s hold
  await h.advance(30000);
  h.watch.sync([boxA], { a: up });
  expect(starts()).toBe(2);
  h.streams[1].exit(127);
  await flush();
  await h.advance(30000);
  h.watch.sync([boxA], { a: up });
  expect(starts()).toBe(2);             // second failure: the hold doubled
  await h.advance(30000);
  h.watch.sync([boxA], { a: up });
  expect(starts()).toBe(3);
  // A healthy run clears the penalty.
  await h.advance(120000);
  h.streams[2].exit(255);
  await flush();
  h.watch.sync([boxA], { a: up });
  expect(starts()).toBe(4);
});

test('a stream that stops beating is killed and replaced', async () => {
  const h = harness();
  h.watch.sync([boxA], { a: up });
  await h.advance(40000);
  h.streams[0].onData('h\n', 'stdout');
  await h.advance(40000);
  h.watch.sync([boxA], { a: up });
  expect(h.streams[0].killed).toBe(false); // beat 40 s ago: alive
  await h.advance(40000);
  h.watch.sync([boxA], { a: up });
  expect(h.streams[0].killed).toBe(true);  // silent for 80 s: hung
  expect(h.live().length).toBe(1);
  expect(h.streams.length).toBe(2);
});

test('a spawn that throws (an unsafe box) is a failure, not a crash, and is not retried every sweep', async () => {
  let spawns = 0;
  const h = harness({ spawnStream: () => { spawns += 1; throw new Error('unsafe box'); } });
  expect(() => h.watch.sync([boxA], { a: up })).not.toThrow();
  expect(h.watch.size()).toBe(0);
  h.watch.sync([boxA], { a: up });
  h.watch.sync([boxA], { a: up });
  expect(spawns).toBe(1);               // held off, like any stream that dies at once
  await h.advance(30000);
  h.watch.sync([boxA], { a: up });
  expect(spawns).toBe(2);
});

test('an onChange that throws does not break the stream: the next change still runs', async () => {
  let calls = 0;
  const h = harness({ onChange: () => { calls += 1; throw new Error('boom'); } });
  h.watch.sync([boxA], { a: up });
  h.streams[0].onData('c\n', 'stdout');
  await h.advance(1000);
  expect(calls).toBe(1);
  h.streams[0].onData('c\n', 'stdout');
  await h.advance(1000);
  expect(calls).toBe(2);
  expect(h.streams[0].killed).toBe(false);
  // Rejecting asynchronously is no different.
  const h2 = harness({ onChange: async () => { calls += 1; throw new Error('later'); } });
  h2.watch.sync([boxA], { a: up });
  h2.streams[0].onData('c\n', 'stdout');
  await h2.advance(1000);
  h2.streams[0].onData('c\n', 'stdout');
  await h2.advance(1000);
  expect(calls).toBe(4);
});

test('stopAll kills every stream and nothing restarts by itself', async () => {
  const h = harness();
  h.watch.sync([boxA, boxB], { a: up, b: up });
  h.watch.stopAll();
  await flush();
  expect(h.live()).toEqual([]);
  expect(h.watch.size()).toBe(0);
  // A change still buffered in a killed stream goes nowhere.
  h.streams[0].onData('c\n', 'stdout');
  await flush();
  expect(h.changes).toEqual([]);
  // A sweep still in flight at shutdown calls sync once more: it must not
  // bring the streams back just as the process is leaving.
  const before = h.streams.length;
  h.watch.sync([boxA, boxB], { a: up, b: up });
  expect(h.streams.length).toBe(before);
  expect(h.watch.size()).toBe(0);
});

test('a stream that fell back off the shared connection is dropped and held, not kept resident', async () => {
  // The box's multiplexed connection is out of session slots (sshd MaxSessions).
  // ssh then says so and silently opens a connection of its own — which this
  // stream would hold open for good. It must give the box its slots back.
  const h = harness();
  h.watch.sync([boxA], { a: up });
  h.streams[0].onData('mux_client_request_session: session request failed: Session open refused by peer\r\n', 'stderr');
  await flush();
  expect(h.streams[0].killed).toBe(true);
  expect(h.watch.size()).toBe(0);
  h.watch.sync([boxA], { a: up });
  expect(h.streams.length).toBe(1);     // held
  await h.advance(5 * 60 * 1000);
  h.watch.sync([boxA], { a: up });
  expect(h.streams.length).toBe(2);     // tried again later
  // Any other stderr noise (a login banner, a locale warning) is not that.
  h.streams[1].onData('Warning: Permanently added host to the list of known hosts.\n', 'stderr');
  await flush();
  expect(h.streams[1].killed).toBe(false);
});

test('yield() drops a box\'s stream and holds it, for a caller that saw the connection saturated', async () => {
  const h = harness();
  h.watch.sync([boxA, boxB], { a: up, b: up });
  h.watch.yield('a');
  expect(h.streams[0].killed).toBe(true);
  expect(h.streams[1].killed).toBe(false);
  h.watch.sync([boxA, boxB], { a: up, b: up });
  expect(h.live().map((s) => s.box.id)).toEqual(['b']);
  await h.advance(5 * 60 * 1000);
  h.watch.sync([boxA, boxB], { a: up, b: up });
  expect(h.live().map((s) => s.box.id).sort()).toEqual(['a', 'b']);
  h.watch.yield('nope');                // unknown box: harmless
});

// --- the Host Shell's own marker directory --------------------------------

test('the local watch fires on a marker write, once per burst', async () => {
  const home = tempHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  let fired = 0;
  const w = createLocalMarkWatch({ dir, onChange: () => { fired += 1; }, debounceMs: 80 });
  cleanups.push(() => w.close());
  expect(w.ensure()).toBe(true);
  // The hook writes a temp file and renames it: several events, one report.
  fs.writeFileSync(path.join(dir, 'local.tmp'), 'local:working:1:prompt\n');
  fs.renameSync(path.join(dir, 'local.tmp'), path.join(dir, 'local'));
  expect(await until(() => fired === 1, 3000)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  expect(fired).toBe(1);
  fs.writeFileSync(path.join(dir, 'local'), 'local:ready:2:stop\n');
  expect(await until(() => fired === 2, 3000)).toBe(true);
});

test('the local watch waits for a directory that does not exist yet', async () => {
  const home = tempHome();
  const dir = path.join(home, '.tmuxifier-agent');
  let fired = 0;
  const w = createLocalMarkWatch({ dir, onChange: () => { fired += 1; }, debounceMs: 50 });
  cleanups.push(() => w.close());
  expect(w.ensure()).toBe(false);
  fs.mkdirSync(dir);
  expect(w.ensure()).toBe(true);
  fs.writeFileSync(path.join(dir, 'local'), 'local:working:1:prompt\n');
  expect(await until(() => fired >= 1, 3000)).toBe(true);
});

test('the local watch re-arms after its directory is removed and recreated', async () => {
  const home = tempHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  let fired = 0;
  const w = createLocalMarkWatch({ dir, onChange: () => { fired += 1; }, debounceMs: 50 });
  cleanups.push(() => w.close());
  w.ensure();
  fs.rmSync(dir, { recursive: true });
  await new Promise((r) => setTimeout(r, 300));
  fs.mkdirSync(dir);
  expect(await until(() => w.ensure(), 3000)).toBe(true);
  const before = fired;
  fs.writeFileSync(path.join(dir, 'local'), 'local:working:1:prompt\n');
  expect(await until(() => fired > before, 3000)).toBe(true);
});

test('local refreshes never overlap: a change during one runs exactly one more afterwards', async () => {
  const home = tempHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  let running = 0;
  let peak = 0;
  let runs = 0;
  let release;
  let gate = new Promise((r) => { release = r; });
  const w = createLocalMarkWatch({
    dir, debounceMs: 30, minGapMs: 0,
    onChange: async () => { runs += 1; running += 1; peak = Math.max(peak, running); await gate; running -= 1; },
  });
  cleanups.push(() => w.close());
  w.ensure();
  fs.writeFileSync(path.join(dir, 'local'), 'local:working:1:prompt\n');
  expect(await until(() => runs === 1, 3000)).toBe(true);
  // The Host Shell sampler runs a python sweep first, so it easily outlasts
  // the debounce. Changes that arrive meanwhile wait for it.
  fs.writeFileSync(path.join(dir, 'local'), 'local:blocked:2:permission\n');
  await new Promise((r) => setTimeout(r, 200));
  fs.writeFileSync(path.join(dir, 'local'), 'local:ready:3:stop\n');
  await new Promise((r) => setTimeout(r, 200));
  expect(runs).toBe(1);
  gate = Promise.resolve();
  release();
  expect(await until(() => runs === 2, 3000)).toBe(true);
  await new Promise((r) => setTimeout(r, 300));
  expect(runs).toBe(2);
  expect(peak).toBe(1);
});

test('the local watch notices a directory swapped out from under it, even with no delete event seen', async () => {
  const home = tempHome();
  const dir = path.join(home, '.tmuxifier-agent');
  fs.mkdirSync(dir);
  let fired = 0;
  const w = createLocalMarkWatch({ dir, onChange: () => { fired += 1; }, debounceMs: 30, minGapMs: 0 });
  cleanups.push(() => w.close());
  expect(w.ensure()).toBe(true);
  // Removed and recreated back to back: the path exists again before anything
  // could react, but it is a different directory and the old watch is deaf.
  fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir);
  expect(w.ensure()).toBe(true);
  await new Promise((r) => setTimeout(r, 150));
  const before = fired;
  fs.writeFileSync(path.join(dir, 'local'), 'local:working:1:prompt\n');
  expect(await until(() => fired > before, 3000)).toBe(true);
});
