import { test, expect } from 'vitest';
import { createServiceChecker } from '../src/server/serviceChecker.js';

const fakeStore = (services) => ({ listServices: async () => services });
const upCheck = async () => ({ state: 'up', latencyMs: 5 });

test('pollOnce builds a snapshot keyed by service id and stamps checkedAt', async () => {
  const store = fakeStore([
    { id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } },
    { id: 'svc-b', url: 'http://b.example.com/', check: { kind: 'tcp', target: 'b.example.com:53' } },
  ]);
  const checker = createServiceChecker({ store, check: upCheck });
  expect(checker.getSnapshot()).toEqual({ checkedAt: null, results: {} });
  const snap = await checker.pollOnce();
  expect(Object.keys(snap.results).sort()).toEqual(['svc-a', 'svc-b']);
  expect(snap.results['svc-a']).toEqual({ state: 'up', latencyMs: 5 });
  expect(typeof snap.checkedAt).toBe('string');
  expect(checker.getSnapshot()).toBe(snap);
});

test("kind 'none' services are never probed and absent from results", async () => {
  const calls = [];
  const store = fakeStore([
    { id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'none' } },
    { id: 'svc-b', url: 'http://b.example.com/', check: { kind: 'http' } },
  ]);
  const checker = createServiceChecker({ store, check: async (s) => { calls.push(s.id); return { state: 'up' }; } });
  const snap = await checker.pollOnce();
  expect(calls).toEqual(['svc-b']);
  expect(snap.results['svc-a']).toBeUndefined();
});

test('getSnapshot never triggers checks; a wholesale swap drops removed services', async () => {
  let services = [{ id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } }];
  let calls = 0;
  const checker = createServiceChecker({
    store: { listServices: async () => services },
    check: async () => { calls++; return { state: 'up' }; },
  });
  await checker.pollOnce();
  for (let i = 0; i < 5; i++) checker.getSnapshot();
  expect(calls).toBe(1);
  services = [];
  const snap = await checker.pollOnce();
  expect(snap.results).toEqual({});
});

test('bounded concurrency', async () => {
  let inFlight = 0, peak = 0;
  const services = Array.from({ length: 9 }, (_, i) => ({ id: `svc-${i}`, url: 'http://x.example.com/', check: { kind: 'http' } }));
  const checker = createServiceChecker({
    store: fakeStore(services),
    concurrency: 3,
    check: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; return { state: 'up' };
    },
  });
  await checker.pollOnce();
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(3);
});

test('overlapping pollOnce calls coalesce', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let probes = 0;
  const checker = createServiceChecker({
    store: fakeStore([{ id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } }]),
    check: async () => { probes++; await gate; return { state: 'up' }; },
  });
  const p1 = checker.pollOnce();
  const p2 = checker.pollOnce();
  release();
  const [s1, s2] = await Promise.all([p1, p2]);
  expect(probes).toBe(1);
  expect(s1).toBe(s2);
});

test('a sweep carries pihole metrics into the snapshot and retains live clients', async () => {
  const retained = [];
  const store = {
    listServices: async () => [
      { id: 'p1', name: 'pihole', url: 'http://127.0.0.1/', check: { kind: 'pihole' }, hasPassword: true },
      { id: 'h1', name: 'web', url: 'http://127.0.0.1/', check: { kind: 'http' } },
      { id: 'n1', name: 'link', url: 'http://127.0.0.1/', check: { kind: 'none' } },
    ],
  };
  const checker = createServiceChecker({
    store,
    piholeRegistry: { clientFor: async () => ({}), retain: async (ids) => { retained.push(ids); }, closeAll: async () => {} },
    check: async (svc) => (svc.check.kind === 'pihole'
      ? { state: 'up', latencyMs: 3, pihole: { queriesTotal: 7 } }
      : { state: 'up', latencyMs: 1 }),
  });
  const snap = await checker.pollOnce();
  expect(snap.results.p1.pihole).toEqual({ queriesTotal: 7 });
  expect(snap.results.h1.pihole).toBeUndefined();
  expect(snap.results.n1).toBeUndefined();
  expect(retained).toEqual([['p1']]);
});

test('start polls immediately then schedules; stop clears; interval clamps to 5000', async () => {
  let calls = 0; const scheduled = []; let cleared = null;
  const checker = createServiceChecker({
    store: fakeStore([{ id: 'svc-a', url: 'http://a.example.com/', check: { kind: 'http' } }]),
    check: async () => { calls++; return { state: 'up' }; },
    intervalMs: 1, // clamps up to 5000
    setIntervalFn: (fn, ms) => { scheduled.push(ms); return 42; },
    clearIntervalFn: (id) => { cleared = id; },
  });
  await checker.start();
  expect(calls).toBe(1);
  expect(scheduled).toEqual([5000]);
  checker.stop();
  expect(cleared).toBe(42);
});
