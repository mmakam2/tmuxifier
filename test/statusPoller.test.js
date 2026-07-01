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
