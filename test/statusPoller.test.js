import { test, expect } from 'vitest';
import { createStatusPoller } from '../src/server/statusPoller.js';
import { createProxmoxInventory, mergeProxmoxStatus } from '../src/server/proxmoxInventory.js';
import { createHealthHistory } from '../src/server/healthHistory.js';

const fakeStore = (boxes) => ({ listBoxes: async () => boxes });

test('pollOnce builds a snapshot keyed by box id from checkBox', async () => {
  const store = fakeStore([{ id: 'a', host: 'ha' }, { id: 'b', host: 'hb' }]);
  const statusChecker = { checkBox: async (b) => ({ reachable: true, host: b.host }) };
  const poller = createStatusPoller({ store, statusChecker });
  const snap = await poller.pollOnce();
  expect(snap).toEqual({ a: { reachable: true, host: 'ha' }, b: { reachable: true, host: 'hb' } });
  expect(poller.getSnapshot()).toEqual(snap);
});

test('getSnapshot reads never trigger checkBox (status SSH volume is independent of tab count)', async () => {
  let calls = 0;
  const store = fakeStore([{ id: 'a', host: 'ha' }]);
  const statusChecker = { checkBox: async () => { calls++; return { reachable: true }; } };
  const poller = createStatusPoller({ store, statusChecker });
  await poller.pollOnce();
  expect(calls).toBe(1);
  for (let i = 0; i < 7; i++) poller.getSnapshot(); // seven tabs each fetch /api/status
  expect(calls).toBe(1);                            // still a single probe cycle
});

test('pollOnce probes with bounded concurrency (no fleet-wide SSH burst)', async () => {
  let inFlight = 0, peak = 0;
  const boxes = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, host: `h${i}` }));
  const statusChecker = {
    checkBox: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; return { reachable: true };
    },
  };
  const poller = createStatusPoller({ store: fakeStore(boxes), statusChecker, concurrency: 2 });
  await poller.pollOnce();
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(2);
});

test('a wholesale snapshot swap drops boxes that no longer exist', async () => {
  let boxes = [{ id: 'a', host: 'ha' }, { id: 'b', host: 'hb' }];
  const poller = createStatusPoller({
    store: { listBoxes: async () => boxes },
    statusChecker: { checkBox: async () => ({ reachable: true }) },
  });
  await poller.pollOnce();
  expect(Object.keys(poller.getSnapshot())).toEqual(['a', 'b']);
  boxes = [{ id: 'a', host: 'ha' }];               // box b removed
  await poller.pollOnce();
  expect(Object.keys(poller.getSnapshot())).toEqual(['a']);
});

test('pollOnce feeds the snapshot and the boxes to history.record', async () => {
  const calls = [];
  const boxes = [{ id: 'a', host: 'ha', label: 'web-01' }];
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    history: { record: (snap, bx) => calls.push([snap, bx]) },
  });
  await poller.pollOnce();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toEqual({ a: { reachable: true } });
  expect(calls[0][1]).toBe(boxes);
});

test('a throwing history.record never prevents the snapshot swap', async () => {
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'a', host: 'ha' }]),
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    history: { record: () => { throw new Error('boom'); } },
  });
  await expect(poller.pollOnce()).resolves.toBeTruthy();
  expect(poller.getSnapshot()).toEqual({ a: { reachable: true } });
});

test('start runs an immediate poll then schedules the recurring poll', async () => {
  let calls = 0;
  const store = fakeStore([{ id: 'a', host: 'ha' }]);
  const statusChecker = { checkBox: async () => { calls++; return { reachable: true }; } };
  const scheduled = [];
  const poller = createStatusPoller({
    store, statusChecker, intervalMs: 1000,
    setIntervalFn: (fn) => { scheduled.push(fn); return 42; },
  });
  await poller.start();
  expect(calls).toBe(1);            // immediate poll on start
  expect(scheduled).toHaveLength(1);
  await scheduled[0]();             // simulate the interval firing
  expect(calls).toBe(2);
});

test('stop clears the scheduled interval', async () => {
  let cleared = null;
  const poller = createStatusPoller({
    store: fakeStore([]),
    statusChecker: { checkBox: async () => ({}) },
    setIntervalFn: () => 99,
    clearIntervalFn: (id) => { cleared = id; },
  });
  await poller.start();
  poller.stop();
  expect(cleared).toBe(99);
});

// The interval fires on a fixed cadence whether or not the previous cycle
// finished. Overlapping cycles used to double history.record per interval
// (defeating the two-consecutive-samples cpu debounce) and let an older poll
// finish later and overwrite a newer snapshot with stale data.
test('overlapping pollOnce calls coalesce into a single probe cycle', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let probes = 0;
  const records = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'a', host: 'ha' }]),
    statusChecker: { checkBox: async () => { probes++; await gate; return { reachable: true }; } },
    history: { record: (snap) => records.push(snap) },
  });
  const p1 = poller.pollOnce();
  const p2 = poller.pollOnce(); // the next interval tick fires mid-cycle
  release();
  const [s1, s2] = await Promise.all([p1, p2]);
  expect(probes).toBe(1);            // one probe cycle, not two
  expect(records).toHaveLength(1);   // one history sample per cycle
  expect(s1).toBe(s2);               // both callers see the same snapshot
});

test('a new poll starts normally once the previous cycle has settled', async () => {
  let probes = 0;
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'a', host: 'ha' }]),
    statusChecker: { checkBox: async () => { probes++; return { reachable: true }; } },
  });
  await poller.pollOnce();
  await poller.pollOnce();
  expect(probes).toBe(2);
});

// PVE collection now precedes the probe cycle rather than running alongside it,
// because its result gates which boxes are probed at all. The box here is
// running, so it is probed; the stopped case is covered below.
test('pollOnce collects PVE state before probing and records the enriched snapshot', async () => {
  const boxes = [{ id: 'b1', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'pve', vmid: 131 } }];
  const order = [];
  const records = [];
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker: { checkBox: async () => { order.push('ssh'); return { reachable: false, error: 'timeout' }; } },
    statusEnricher: {
      collect: async () => { order.push('pve'); return [{ boxId: 'b1', state: 'running', node: 'pve', vmid: 131 }]; },
      merge: (snapshot, bx, pve) => ({ b1: { ...snapshot.b1, proxmoxState: pve[0].state, proxmoxVmid: pve[0].vmid } }),
    },
    history: { record: (snapshot) => records.push(snapshot) },
  });
  const snapshot = await poller.pollOnce();
  expect(order).toEqual(['pve', 'ssh']); // ordering is load-bearing: the gate needs PVE state first
  expect(snapshot.b1.proxmoxState).toBe('running');
  expect(records[0]).toEqual(snapshot);
});

test('a throwing PVE collector preserves the SSH snapshot', async () => {
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => ({ reachable: false, error: 'timeout' }) },
    statusEnricher: { collect: async () => { throw new Error('PVE down'); }, merge: () => ({}) },
  });
  expect(await poller.pollOnce()).toEqual({ b1: { reachable: false, error: 'timeout' } });
});

// --- PVE-gated probing ------------------------------------------------------
// A container Proxmox reports stopped has no sshd to answer, so probing it
// spends a full ConnectTimeout for a foregone conclusion — and because the
// snapshot swaps wholesale, that delay lands on every other box too.

const enricherFor = (records) => ({
  collect: async () => records,
  merge: (snapshot, boxes, pve) => {
    const next = { ...snapshot };
    for (const r of pve) next[r.boxId] = { ...(next[r.boxId] || {}), proxmoxState: r.state, proxmoxVmid: r.vmid };
    return next;
  },
});

test('a box PVE reports stopped is not SSH-probed', async () => {
  const probed = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'off', host: '192.168.1.10' }, { id: 'on', host: '192.168.1.11' }]),
    statusChecker: { checkBox: async (b) => { probed.push(b.id); return { reachable: true }; } },
    statusEnricher: enricherFor([
      { boxId: 'off', state: 'stopped', node: 'pve', vmid: 131 },
      { boxId: 'on', state: 'running', node: 'pve', vmid: 132 },
    ]),
  });
  const snap = await poller.pollOnce();
  expect(probed).toEqual(['on']);
  expect(snap.off.reachable).toBe(false);
  expect(snap.off.proxmoxState).toBe('stopped');
  expect(snap.on.reachable).toBe(true);
});

test('an unlinked box is always probed (PVE has nothing to say about it)', async () => {
  const probed = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'plain', host: '192.168.1.12' }]),
    statusChecker: { checkBox: async (b) => { probed.push(b.id); return { reachable: true }; } },
    statusEnricher: enricherFor([]),
  });
  await poller.pollOnce();
  expect(probed).toEqual(['plain']);
});

test('a failed PVE read fails open: every box is probed', async () => {
  const probed = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'off', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async (b) => { probed.push(b.id); return { reachable: true }; } },
    statusEnricher: { collect: async () => { throw new Error('PVE down'); }, merge: () => ({}) },
  });
  await poller.pollOnce();
  expect(probed).toEqual(['off']);
});

test('a box PVE reports stopped is probed again as soon as PVE reports it running', async () => {
  const probed = [];
  let state = 'stopped';
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async (b) => { probed.push(b.id); return { reachable: true }; } },
    statusEnricher: { ...enricherFor([]), collect: async () => [{ boxId: 'b1', state, node: 'pve', vmid: 131 }] },
  });
  await poller.pollOnce();
  expect(probed).toEqual([]);
  state = 'running';
  await poller.pollOnce();
  expect(probed).toEqual(['b1']);
});

// --- refreshUntil (post-lifecycle fast-track) -------------------------------

test('refreshUntil re-sweeps until the box answers, then stops', async () => {
  let sweeps = 0;
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => ({ reachable: ++sweeps >= 3 }) },
    sleep: async () => {},
  });
  await expect(poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 })).resolves.toBe(true);
  expect(sweeps).toBe(3);
});

test('refreshUntil gives up at the deadline rather than sweeping forever', async () => {
  let sweeps = 0;
  let clock = 0;
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => { sweeps++; return { reachable: false }; } },
    sleep: async () => { clock += 5000; },
    now: () => clock,
  });
  await expect(poller.refreshUntil('b1', { intervalMs: 5000, timeoutMs: 20_000 })).resolves.toBe(false);
  expect(sweeps).toBeLessThanOrEqual(5);
  expect(sweeps).toBeGreaterThan(1);
});

test('refreshUntil does not stack a second loop for the same box', async () => {
  let sweeps = 0;
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => ({ reachable: ++sweeps >= 4 }) },
    sleep: async () => {},
  });
  const [a, b] = await Promise.all([
    poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 }),
    poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 }),
  ]);
  expect(a).toBe(true);
  expect(b).toBe(true);
  expect(sweeps).toBe(4); // one loop, not two racing each other
});

// B7 (2026-07-29 review): every fast-track sweep went through checkBox, whose
// failure backoff (30/60/90s) returns the cached failure without touching SSH.
// A container whose sshd answers at t=35s therefore stayed "down" until t=90s,
// and a ~100s boot exhausted the 180s deadline — the fast track tracked the
// backoff schedule, not the box's boot time.
test('refreshUntil clears the target backoff so the fast track is not throttled', async () => {
  const reset = [];
  let sweeps = 0;
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: {
      checkBox: async () => ({ reachable: ++sweeps >= 3 }),
      resetBackoff: (key) => reset.push(key),
    },
    sleep: async () => {},
  });
  await expect(poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 })).resolves.toBe(true);
  expect(reset).toEqual(['b1', 'b1', 'b1']); // once per sweep, not once per loop
});

test('refreshUntil still works against a checker with no resetBackoff', async () => {
  let sweeps = 0;
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => ({ reachable: ++sweeps >= 2 }) },
    sleep: async () => {},
  });
  await expect(poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 })).resolves.toBe(true);
});

// E3 (2026-07-29 review). The fast track called pollOnce, which sweeps the whole
// fleet. Pressing START on one container therefore re-probed every box every 5s
// for up to 3 minutes — roughly 300 extra SSH probes on a 10-box fleet to learn
// one container's boot state, and each sweep's slowest box delayed the answer
// about the one box the caller actually asked about.
test('the fast track probes only its target, not the whole fleet', async () => {
  const probed = [];
  const poller = createStatusPoller({
    store: fakeStore([
      { id: 'b1', host: '192.168.1.10' },
      { id: 'b2', host: '192.168.1.11' },
      { id: 'b3', host: '192.168.1.12' },
    ]),
    statusChecker: { checkBox: async (b) => { probed.push(b.id); return { reachable: probed.filter((x) => x === 'b1').length >= 3 }; } },
    sleep: async () => {},
  });
  await expect(poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 })).resolves.toBe(true);
  expect(new Set(probed)).toEqual(new Set(['b1']));
  expect(probed).toHaveLength(3);
});

test('the fast track patches its box into the snapshot without disturbing the others', async () => {
  const boxes = [{ id: 'b1', host: '192.168.1.10' }, { id: 'b2', host: '192.168.1.11' }];
  let b1Up = false;
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker: { checkBox: async (b) => (b.id === 'b1' ? { reachable: b1Up } : { reachable: true, host: b.host }) },
    sleep: async () => {},
  });
  await poller.pollOnce();
  const before = poller.getSnapshot();
  expect(before.b2).toEqual({ reachable: true, host: '192.168.1.11' });

  b1Up = true;
  await poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 });
  const after = poller.getSnapshot();
  expect(after.b1).toEqual({ reachable: true });
  expect(after.b2).toEqual(before.b2);
  // A new object, not a mutation of the one readers already hold — the same
  // invariant the wholesale swap keeps.
  expect(after).not.toBe(before);
});

// history.record() deletes the series of every box absent from its `boxes`
// argument, so a single-box record would wipe the rest of the fleet's history.
// The fast track therefore records nothing and leaves the series to the regular
// sweep, which is also the honest cadence: a lifecycle action on one box should
// not densify another's health series.
test('the fast track does not record history', async () => {
  const recorded = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }, { id: 'b2', host: '192.168.1.11' }]),
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    history: { record: (snap, boxes) => recorded.push(boxes.map((b) => b.id)) },
    sleep: async () => {},
  });
  await poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 });
  expect(recorded).toEqual([]);
  // The regular sweep still records the whole fleet.
  await poller.pollOnce();
  expect(recorded).toEqual([['b1', 'b2']]);
});

// The PVE gate is the reason a stopped container does not cost a full
// ConnectTimeout per attempt. Losing it in the targeted path would have made
// the fast track spend the entire 3-minute deadline waiting on a box with no
// sshd — the exact cost the gate was added to avoid.
test('the fast track still skips SSH while PVE reports the container stopped', async () => {
  let sshProbes = 0;
  let pveState = 'stopped';
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => { sshProbes++; return { reachable: true }; } },
    statusEnricher: {
      collect: async () => [{ boxId: 'b1', state: pveState }],
      merge: (snap, boxes, recs) => {
        const out = { ...snap };
        for (const r of recs) if (out[r.boxId]) out[r.boxId] = { ...out[r.boxId], proxmoxState: r.state };
        return out;
      },
    },
    sleep: async () => { pveState = 'running'; },
  });
  await expect(poller.refreshUntil('b1', { intervalMs: 1, timeoutMs: 10_000 })).resolves.toBe(true);
  expect(sshProbes).toBe(1); // the stopped attempt cost no SSH at all
  expect(poller.getSnapshot().b1.proxmoxState).toBe('running');
});

test('the fast track resolves false for a box that no longer exists', async () => {
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: '192.168.1.10' }]),
    statusChecker: { checkBox: async () => ({ reachable: true }) },
    sleep: async () => {},
    now: (() => { let t = 0; return () => (t += 60_000); })(),
  });
  await expect(poller.refreshUntil('gone', { intervalMs: 1, timeoutMs: 1 })).resolves.toBe(false);
});

// --- the __local__ pseudo-box (Host Shell) ----------------------------------
// The Host Shell has no SSH probe, so its agent state rides the history rails
// as a synthetic box. It must reach history.record() and never /api/status.
// The tests above build their checker inline; these two share one, since what
// they assert has nothing to do with the probe result.
const statusChecker = { checkBox: async () => ({ reachable: true }) };

test('pollOnce feeds a __local__ pseudo-box to history when a local sampler is present', async () => {
  const calls = [];
  const localAgent = {
    sample: async () => ({
      reachable: true,
      sessions: [{ name: 'local', windows: 1, attached: false, activity: 1, paneCmd: 'claude' }],
      agentMarks: { local: { state: 'working', ts: 1 } },
    }),
  };
  const boxes = [{ id: 'b1', host: 'h1' }];
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker,
    history: { record: (snap, bx) => calls.push([snap, bx]) },
    localAgent,
  });
  await poller.pollOnce();
  const [snap, bx] = calls[0];
  expect(snap.__local__.agentMarks.local.state).toBe('working');
  expect(snap.b1).toBeDefined();
  expect(bx.at(-1)).toEqual({ id: '__local__', label: 'Host Shell', host: 'localhost', sessionName: 'local' });
  // The pseudo-box exists only in the history feed — never in /api/status.
  expect(poller.getSnapshot().__local__).toBeUndefined();
});

// A rejecting sampler is caught; a sampler that never settles is not, unless
// the await is raced against a deadline. pollOnce coalesces every caller onto
// `inFlight`, which clears only when the cycle finishes — so a wedged sampler
// would freeze status polling for the WHOLE fleet, not just the Host Shell.
test('a hung local sampler cannot wedge the poll cycle', async () => {
  const calls = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: 'h1' }]),
    statusChecker,
    history: { record: (snap, bx) => calls.push([snap, bx]) },
    localAgent: { sample: () => new Promise(() => {}) }, // never settles
    localSampleTimeoutMs: 10,
  });
  await expect(poller.pollOnce()).resolves.toBeTruthy();
  const [snap, bx] = calls[0];
  expect(snap.__local__).toBeUndefined();
  // Still listed, so record() keeps (does not prune) the Host Shell's state.
  expect(bx.map((b) => b.id)).toEqual(['b1', '__local__']);
  // inFlight was released, so the next interval tick is a real cycle again.
  await poller.pollOnce();
  expect(calls).toHaveLength(2);
});

test('a throwing local sampler still records the real boxes', async () => {
  const calls = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: 'h1' }]),
    statusChecker,
    history: { record: (snap, bx) => calls.push([snap, bx]) },
    localAgent: { sample: async () => { throw new Error('boom'); } },
  });
  await poller.pollOnce();
  const [snap, bx] = calls[0];
  expect(snap.__local__).toBeUndefined();
  expect(bx.map((b) => b.id)).toEqual(['b1', '__local__']);
});

// I1: the client can open and acknowledge only the Host Shell's own session,
// so any other host tmux session would latch `done` with no way to clear it.
const twoLocalSessions = () => ({
  reachable: true,
  tmux: true,
  sessions: [
    { name: 'local', windows: 1, attached: false, activity: 1, paneCmd: 'claude' },
    { name: 'other', windows: 1, attached: false, activity: 1, paneCmd: 'claude' },
  ],
  agentMarks: { local: { state: 'ready', cause: 'stop', ts: 5 }, other: { state: 'ready', cause: 'stop', ts: 5 } },
});

test('the __local__ sample is narrowed to the Host Shell session before recording', async () => {
  const calls = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: 'h1' }]),
    statusChecker,
    history: { record: (snap, bx) => calls.push([snap, bx]) },
    localAgent: { sample: async () => twoLocalSessions() },
  });
  await poller.pollOnce();
  const [snap] = calls[0];
  expect(snap.__local__.sessions.map((x) => x.name)).toEqual(['local']);
  // Markers are kept as-is; sampleOf ignores them for unlisted sessions.
  expect(Object.keys(snap.__local__.agentMarks).sort()).toEqual(['local', 'other']);
});

test('a local sample with sessions local and other records an agents map of only local', async () => {
  const history = createHealthHistory();
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: 'h1' }]),
    statusChecker,
    history,
    localAgent: { sample: async () => twoLocalSessions() },
  });
  await poller.pollOnce();
  const last = history.getSeries('__local__').at(-1);
  expect(Object.keys(last.agents)).toEqual(['local']);
  expect(last.agents.local.state).toBe('done');
});

// I2a: a lost sampler race must not prune the Host Shell's seen watermark.
test('a sampler that returns null keeps __local__ listed and absent from the snapshot', async () => {
  const calls = [];
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: 'h1' }]),
    statusChecker,
    history: { record: (snap, bx) => calls.push([snap, bx]) },
    localAgent: { sample: async () => null },
  });
  await poller.pollOnce();
  const [snap, bx] = calls[0];
  expect(Object.hasOwn(snap, '__local__')).toBe(false);
  expect(bx.map((b) => b.id)).toEqual(['b1', '__local__']);
});

test('a lost sampler race keeps the Host Shell seen watermark (real history)', async () => {
  const saved = [];
  const seenStore = { load: () => null, save: (v) => saved.push(JSON.parse(JSON.stringify(v))) };
  const history = createHealthHistory({ seenStore });
  let next = {
    reachable: true,
    sessions: [{ name: 'local', windows: 1, attached: false, activity: 1, paneCmd: 'claude' }],
    agentMarks: { local: { state: 'ready', cause: 'stop', ts: 7 } },
  };
  const poller = createStatusPoller({
    store: fakeStore([{ id: 'b1', host: 'h1' }]),
    statusChecker,
    history,
    localAgent: { sample: async () => next },
  });
  await poller.pollOnce();
  expect(history.markSeen('__local__', 'local', 7)).toBe(true);
  next = null; // sampler loses its race / returns nothing
  await poller.pollOnce();
  next = {
    reachable: true,
    sessions: [{ name: 'local', windows: 1, attached: false, activity: 1, paneCmd: 'claude' }],
    agentMarks: { local: { state: 'ready', cause: 'stop', ts: 7 } },
  };
  await poller.pollOnce();
  expect(history.getSeries('__local__').at(-1).agents.local.state).toBe('idle');
  expect(saved.at(-1)).toEqual({ __local__: { local: 7 } });
});

test('probeOne overlapping pollOnce does not strip proxmoxState=stopped from other linked boxes or fire false down events', async () => {
  let release;
  let gated = false;
  const gate = new Promise((r) => { release = r; });
  const boxes = [
    { id: 'b1', label: 'web-01', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'pve', vmid: 120, kind: 'lxc', fp: { name: 'web-01', mac: 'BC:24:11:00:00:01' } } },
    { id: 'b2', label: 'db-off', host: '192.168.1.11', proxmox: { hostId: 'H1', node: 'pve', vmid: 121, kind: 'lxc', fp: { name: 'db-off', mac: 'BC:24:11:00:00:02' } } },
  ];
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      getHost: async () => ({ id: 'H1', name: 'pve', endpoint: 'pve.example.com:8006', tokenSecret: 's' }),
      listHosts: async () => [{ id: 'H1', name: 'pve', endpoint: 'pve.example.com:8006' }],
    },
    makeClient: () => ({
      clusterResources: async () => {
        if (gated) await gate;
        return [
          { vmid: 120, node: 'pve', type: 'lxc', status: 'running', name: 'web-01' },
          { vmid: 121, node: 'pve', type: 'lxc', status: 'stopped', name: 'db-off' },
        ];
      },
    }),
    now: () => 1000, log: () => {},
  });
  const history = createHealthHistory({});
  const probed = [];
  const poller = createStatusPoller({
    store: fakeStore(boxes),
    statusChecker: {
      checkBox: async (b) => {
        probed.push(b.id);
        return b.id === 'b1' ? { reachable: true } : { reachable: false, error: 'Connection timed out' };
      },
    },
    statusEnricher: { collect: (bx) => inventory.refreshLinked(bx), merge: mergeProxmoxStatus },
    history,
  });

  // Seed history cleanly: b1 running, b2 stopped.
  await poller.pollOnce();
  expect(probed).toEqual(['b1']);
  probed.length = 0;

  // Now probeOne('b1') starts while pollOnce() overlaps it on the same PVE sweep window.
  gated = true;
  const pOne = poller.probeOne('b1');
  const pSweep = poller.pollOnce();
  release();
  await Promise.all([pOne, pSweep]);

  expect(probed).not.toContain('b2'); // stopped linked container b2 was never SSH-probed
  expect(poller.getSnapshot().b2.proxmoxState).toBe('stopped');
  expect(history.getEvents({}).events).toEqual([]); // no false down event on b2
});

// --- refreshAgents: the real-time path (agentWatch.js -> one light probe) ----

const rtBox = { id: 'a', label: 'A', host: 'ha', sessionName: 'web' };
const sess = (cmd = 'claude', attached = false) => [{ name: 'web', windows: 1, attached, paneCmd: cmd }];
const full = (state, cause, ts, extra = {}) => ({
  reachable: true, tmux: true, sessions: sess(), agentMarks: { web: { state, cause, ts } }, metrics: { cpus: 2 }, ...extra,
});
const light = (state, cause, ts) => ({ tmux: true, sessions: sess(), agentMarks: { web: { state, cause, ts } } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('refreshAgents patches sessions and markers into the snapshot and records the edge', async () => {
  const history = createHealthHistory({ now: () => 5 });
  const statusChecker = {
    checkBox: async () => full('working', 'prompt', 100),
    checkAgents: async () => light('blocked', 'permission', 101),
  };
  const poller = createStatusPoller({ store: fakeStore([rtBox]), statusChecker, history });
  await poller.pollOnce();
  const before = poller.getSnapshot();
  expect(await poller.refreshAgents('a')).toBe(true);
  const after = poller.getSnapshot();
  expect(after).not.toBe(before);                    // readers never see a snapshot mutate
  expect(before.a.agentMarks.web.state).toBe('working');
  expect(after.a.agentMarks.web).toEqual({ state: 'blocked', cause: 'permission', ts: 101 });
  expect(after.a.metrics).toEqual({ cpus: 2 });      // the sweep's fields survive
  expect(after.a.reachable).toBe(true);
  expect(history.getSeries('a')).toHaveLength(1);
  expect(history.getSeries('a')[0].agents.web.state).toBe('blocked');
  expect(history.getEvents().events.map((e) => e.kind)).toEqual(['agent-blocked']);
});

test('refreshAgents drops markers the box no longer has', async () => {
  const statusChecker = {
    checkBox: async () => full('ready', 'stop', 100),
    checkAgents: async () => ({ tmux: true, sessions: sess('zsh') }),
  };
  const poller = createStatusPoller({ store: fakeStore([rtBox]), statusChecker });
  await poller.pollOnce();
  expect(await poller.refreshAgents('a')).toBe(true);
  expect(poller.getSnapshot().a).not.toHaveProperty('agentMarks');
  expect(poller.getSnapshot().a.sessions[0].paneCmd).toBe('zsh');
});

test('refreshAgents never probes or marks down: unknown, unreachable and failed boxes are left to the sweep', async () => {
  let light1 = 0;
  let mode = 'down';
  const statusChecker = {
    checkBox: async () => (mode === 'down' ? { reachable: false, error: 'refused' } : full('working', 'prompt', 1)),
    checkAgents: async () => { light1 += 1; return null; },
  };
  const poller = createStatusPoller({ store: fakeStore([rtBox]), statusChecker });
  expect(await poller.refreshAgents('nope')).toBe(false);
  expect(await poller.refreshAgents('a')).toBe(false);   // never swept
  await poller.pollOnce();
  expect(await poller.refreshAgents('a')).toBe(false);   // swept, and down
  expect(light1).toBe(0);
  mode = 'up';
  await poller.pollOnce();
  const snap = poller.getSnapshot();
  expect(await poller.refreshAgents('a')).toBe(false);   // light probe failed
  expect(light1).toBe(1);
  expect(poller.getSnapshot()).toBe(snap);               // and nothing was touched
});

test('a sweep that read the box BEFORE a refresh cannot overwrite the refresh with older state', async () => {
  // The sweep probes `a` (still working), a marker changes, the refresh reads
  // blocked and records it — and only then does the sweep, held up by a slow
  // box, swap its snapshot in. Without the guard the board would flip back to
  // working and the NEXT sweep would notify "blocked" a second time.
  const history = createHealthHistory({ now: () => 5 });
  const slow = deferred();
  let sweeps = 0;
  const statusChecker = {
    checkBox: async (b) => {
      if (b.id === 'slow') { sweeps += 1; if (sweeps === 2) await slow.promise; return { reachable: true, tmux: true, sessions: [] }; }
      return full('working', 'prompt', 100);
    },
    checkAgents: async () => light('blocked', 'permission', 101),
  };
  const poller = createStatusPoller({ store: fakeStore([rtBox, { id: 'slow', host: 'hs' }]), statusChecker, history, concurrency: 4 });
  await poller.pollOnce();
  const sweep = poller.pollOnce();
  await new Promise((r) => setTimeout(r, 10));        // `a` has been read; `slow` is pending
  expect(await poller.refreshAgents('a')).toBe(true);
  slow.resolve();
  await sweep;
  expect(poller.getSnapshot().a.agentMarks.web.state).toBe('blocked');
  expect(poller.getSnapshot().a.metrics).toEqual({ cpus: 2 }); // the sweep's own fields still land
  expect(history.getSeries('a').at(-1).agents.web.state).toBe('blocked');
  expect(history.getEvents().events.map((e) => e.kind)).toEqual(['agent-blocked']);
});

test('a sweep that read the box AFTER a refresh wins: it is the newer read', async () => {
  let state = ['working', 'prompt', 100];
  const statusChecker = {
    checkBox: async () => full(...state),
    checkAgents: async () => light('blocked', 'permission', 101),
  };
  const poller = createStatusPoller({ store: fakeStore([rtBox]), statusChecker });
  await poller.pollOnce();
  await poller.refreshAgents('a');
  state = ['ready', 'stop', 102];
  await poller.pollOnce();
  expect(poller.getSnapshot().a.agentMarks.web.state).toBe('ready');
});

test('a refresh overtaken by a sweep re-reads instead of applying its older answer', async () => {
  // The refresh's probe is in flight while a whole sweep runs and swaps. Its
  // answer predates the sweep's, so applying it would move state backwards.
  const history = createHealthHistory({ now: () => 5 });
  const first = deferred();
  let lights = 0;
  let state = ['working', 'prompt', 100];
  const statusChecker = {
    checkBox: async () => full(...state),
    checkAgents: async () => {
      lights += 1;
      if (lights === 1) { await first.promise; return light('blocked', 'permission', 101); }
      return light('ready', 'stop', 102);
    },
  };
  const poller = createStatusPoller({ store: fakeStore([rtBox]), statusChecker, history });
  await poller.pollOnce();
  const refresh = poller.refreshAgents('a');
  await new Promise((r) => setTimeout(r, 5));
  state = ['ready', 'stop', 102];
  await poller.pollOnce();                            // sweep sees the turn finish
  first.resolve();
  expect(await refresh).toBe(true);
  expect(lights).toBe(2);
  expect(poller.getSnapshot().a.agentMarks.web.state).toBe('ready');
  // working -> done once. Never a stale "blocked" after the fact.
  expect(history.getEvents().events.map((e) => e.kind)).toEqual(['agent-input']);
});

test('onCycle runs after every sweep with the boxes and the fresh snapshot, and cannot break the sweep', async () => {
  const seen = [];
  const statusChecker = { checkBox: async () => ({ reachable: true }) };
  const poller = createStatusPoller({
    store: fakeStore([rtBox]), statusChecker,
    onCycle: (boxes, snap) => { seen.push([boxes.map((b) => b.id), snap]); throw new Error('boom'); },
  });
  const snap = await poller.pollOnce();
  expect(seen).toEqual([[['a'], snap]]);
  await poller.pollOnce();
  expect(seen).toHaveLength(2);
});

test('refreshAgents for the Host Shell samples locally and records without touching the snapshot', async () => {
  const history = createHealthHistory({ now: () => 5 });
  let local = { reachable: true, tmux: true, sessions: [{ name: 'local', windows: 1, attached: false, paneCmd: 'claude' }, { name: 'other', windows: 1, attached: false, paneCmd: 'claude' }], agentMarks: { local: { state: 'working', cause: 'prompt', ts: 100 }, other: { state: 'working', cause: 'prompt', ts: 100 } } };
  const poller = createStatusPoller({
    store: fakeStore([]), statusChecker: { checkBox: async () => ({ reachable: true }) }, history,
    localAgent: { sample: async () => local },
  });
  await poller.pollOnce();
  local = { ...local, agentMarks: { local: { state: 'blocked', cause: 'question', ts: 101 }, other: { state: 'blocked', cause: 'question', ts: 101 } } };
  expect(await poller.refreshAgents('__local__')).toBe(true);
  expect(poller.getSnapshot()).toEqual({});           // the Host Shell never enters /api/status
  const last = history.getSeries('__local__').at(-1);
  expect(last.agents.local.state).toBe('blocked');
  expect(last.agents).not.toHaveProperty('other');    // only the Host Shell's own session is tracked
  expect(history.getEvents().events.map((e) => [e.kind, e.boxId, e.session])).toEqual([['agent-blocked', '__local__', 'local']]);
});

test('a sweep whose Host Shell sample predates a local refresh does not move it backwards', async () => {
  const history = createHealthHistory({ now: () => 5 });
  const mk = (state, cause, ts) => ({ reachable: true, tmux: true, sessions: [{ name: 'local', windows: 1, attached: false, paneCmd: 'claude' }], agentMarks: { local: { state, cause, ts } } });
  const held = deferred();
  let n = 0;
  const poller = createStatusPoller({
    store: fakeStore([]), statusChecker: { checkBox: async () => ({ reachable: true }) }, history,
    localAgent: { sample: async () => { n += 1; if (n === 2) { await held.promise; return mk('working', 'prompt', 100); } return n === 1 ? mk('working', 'prompt', 100) : mk('blocked', 'question', 101); } },
  });
  await poller.pollOnce();                            // n=1: working
  const sweep = poller.pollOnce();                    // n=2: reads working, held
  await new Promise((r) => setTimeout(r, 5));
  expect(await poller.refreshAgents('__local__')).toBe(true); // n=3: blocked
  held.resolve();
  await sweep;
  expect(history.getSeries('__local__').at(-1).agents.local.state).toBe('blocked');
  expect(history.getEvents().events.map((e) => e.kind)).toEqual(['agent-blocked']);
});

test('refreshAgents for the Host Shell is false when no sampler is configured or it yields nothing', async () => {
  const none = createStatusPoller({ store: fakeStore([]), statusChecker: { checkBox: async () => ({}) } });
  expect(await none.refreshAgents('__local__')).toBe(false);
  const empty = createStatusPoller({ store: fakeStore([]), statusChecker: { checkBox: async () => ({}) }, history: createHealthHistory(), localAgent: { sample: async () => null } });
  await empty.pollOnce();
  expect(await empty.refreshAgents('__local__')).toBe(false);
});
