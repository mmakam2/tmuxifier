import { test, expect } from 'vitest';
import { createStatusPoller } from '../src/server/statusPoller.js';

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
