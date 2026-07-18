import { test, expect } from 'vitest';
import { sampleOf, classifyTransitions, initThresholdState, createHealthHistory } from '../src/server/healthHistory.js';

const TH = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 };

test('sampleOf projects reachable status with metrics', () => {
  const s = sampleOf({ reachable: true, tmux: true, metrics: { cpuPct: 40, memTotalKb: 1000, memAvailKb: 250, diskPct: 61 } }, 5);
  expect(s).toEqual({ t: 5, up: true, tmux: true, cpuPct: 40, memPct: 75, diskPct: 61 });
});

test('sampleOf marks needsAuth and unreachable as down, omitting metrics', () => {
  expect(sampleOf({ reachable: false, needsAuth: true }, 1)).toEqual({ t: 1, up: false, needsAuth: true });
  expect(sampleOf({ reachable: false, error: 'x' }, 2)).toEqual({ t: 2, up: false });
});

test('sampleOf omits absent metrics instead of zeroing, and falls back to load when no cgroup', () => {
  const s = sampleOf({ reachable: true, metrics: { load1: 2, cpus: 4 } }, 3); // no cpuPct, no cpuUsageUsec
  expect(s.cpuPct).toBe(50);       // 2/4 → 50%
  expect('memPct' in s).toBe(false);
  expect('diskPct' in s).toBe(false);
});

test('classifyTransitions: reachability edges', () => {
  expect(classifyTransitions({ up: true }, { up: false }, TH, initThresholdState()).events).toEqual([{ kind: 'down' }]);
  expect(classifyTransitions({ up: true }, { up: false, needsAuth: true }, TH, initThresholdState()).events).toEqual([{ kind: 'needs-auth' }]);
  expect(classifyTransitions({ up: false }, { up: true }, TH, initThresholdState()).events).toEqual([{ kind: 'up' }]);
  expect(classifyTransitions({ up: true }, { up: true }, TH, initThresholdState()).events).toEqual([]);
});

test('classifyTransitions: first sample (no prev) seeds without emitting', () => {
  const r = classifyTransitions(undefined, { up: true, diskPct: 95 }, TH, undefined);
  expect(r.events).toEqual([]);
  expect(r.state.disk).toBe(true); // seeded "already over" so it will not re-fire
});

test('classifyTransitions: disk crosses up once, then clears past hysteresis', () => {
  let st = initThresholdState();
  let r = classifyTransitions({ up: true, diskPct: 80 }, { up: true, diskPct: 92 }, TH, st);
  expect(r.events).toEqual([{ kind: 'threshold', metric: 'disk', value: 92 }]);
  st = r.state;
  r = classifyTransitions({ up: true, diskPct: 92 }, { up: true, diskPct: 91 }, TH, st); // still high, no re-fire
  expect(r.events).toEqual([]);
  st = r.state;
  r = classifyTransitions({ up: true, diskPct: 91 }, { up: true, diskPct: 84 }, TH, st); // < 90-5
  expect(r.events).toEqual([{ kind: 'threshold-clear', metric: 'disk', value: 84 }]);
});

test('classifyTransitions: cpu requires two consecutive over-samples', () => {
  let st = initThresholdState();
  let r = classifyTransitions({ up: true, cpuPct: 50 }, { up: true, cpuPct: 95 }, TH, st);
  expect(r.events).toEqual([]);            // first over-sample: wait
  st = r.state;
  r = classifyTransitions({ up: true, cpuPct: 95 }, { up: true, cpuPct: 96 }, TH, st);
  expect(r.events).toEqual([{ kind: 'threshold', metric: 'cpu', value: 96 }]); // sustained → fire
});

test('classifyTransitions: needs-auth then truly down emits a down event', () => {
  const r = classifyTransitions({ up: false, needsAuth: true }, { up: false }, TH, initThresholdState());
  expect(r.events).toEqual([{ kind: 'down' }]);
});

test('classifyTransitions: cpu absent at seed (cgroup warming) adopts the first observed value silently', () => {
  let r = classifyTransitions(undefined, { up: true }, TH, undefined); // restart seed: no cpuPct yet
  r = classifyTransitions({ up: true }, { up: true, cpuPct: 95 }, TH, r.state);
  expect(r.events).toEqual([]); // first observation is the baseline, not a crossing
  r = classifyTransitions({ up: true, cpuPct: 95 }, { up: true, cpuPct: 96 }, TH, r.state);
  expect(r.events).toEqual([]); // still hot, still no restart replay
  r = classifyTransitions({ up: true, cpuPct: 96 }, { up: true, cpuPct: 80 }, TH, r.state);
  expect(r.events).toEqual([{ kind: 'threshold-clear', metric: 'cpu', value: 80 }]);
});

const BOXES = [{ id: 'b1', label: 'web-01', host: 'h1' }, { id: 'b2', label: 'db-01', host: 'h2' }];

test('record caps a down reason so raw ssh stderr never bloats the events log', () => {
  const h = createHealthHistory({});
  h.record({ b1: { reachable: true } }, [BOXES[0]]);
  h.record({ b1: { reachable: false, error: 'x'.repeat(5000) } }, [BOXES[0]]);
  expect(h.getEvents({}).events[0].reason).toHaveLength(300);
});

test('record builds per-box series capped at maxSamples', () => {
  const h = createHealthHistory({ maxSamples: 2, now: (() => { let t = 0; return () => (t += 10); })() });
  for (let i = 0; i < 3; i++) h.record({ b1: { reachable: true, metrics: { cpuPct: i } } }, [BOXES[0]]);
  const s = h.getSeries('b1');
  expect(s).toHaveLength(2);                 // oldest dropped
  expect(s.map((x) => x.cpuPct)).toEqual([1, 2]);
});

test('record emits a down event on transition, persists it, and stamps increasing seq', () => {
  const saved = [];
  const h = createHealthHistory({ save: (evs) => saved.push(evs.length), now: (() => { let t = 0; return () => (t += 1); })() });
  h.record({ b1: { reachable: true } }, [BOXES[0]]);                       // seed — no event
  h.record({ b1: { reachable: false, error: 'kex_exchange_identification' } }, [BOXES[0]]); // down
  const { events, latestSeq } = h.getEvents({});
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ seq: 1, boxId: 'b1', label: 'web-01', host: 'h1', kind: 'down', reason: 'kex_exchange_identification' });
  expect(latestSeq).toBe(1);
  expect(saved[saved.length - 1]).toBe(1); // persisted on the edge
});

test('record fires no event when the status is unchanged (backoff replay)', () => {
  const h = createHealthHistory({});
  h.record({ b1: { reachable: false, error: 'x' } }, [BOXES[0]]); // seed
  h.record({ b1: { reachable: false, error: 'x' } }, [BOXES[0]]); // identical → no edge
  expect(h.getEvents({}).events).toHaveLength(0);
});

test('getEvents newest-first and filters by since', () => {
  const h = createHealthHistory({});
  h.record({ b1: { reachable: true } }, [BOXES[0]]);           // seed
  h.record({ b1: { reachable: false } }, [BOXES[0]]);          // seq 1 down
  h.record({ b1: { reachable: true } }, [BOXES[0]]);           // seq 2 up
  const all = h.getEvents({});
  expect(all.events.map((e) => e.kind)).toEqual(['up', 'down']); // newest-first
  expect(h.getEvents({ since: 1 }).events.map((e) => e.seq)).toEqual([2]);
});

test('record prunes series + state for removed boxes', () => {
  const h = createHealthHistory({});
  h.record({ b1: { reachable: true }, b2: { reachable: true } }, BOXES);
  expect(Object.keys(h.getSeries())).toEqual(['b1', 'b2']);
  h.record({ b1: { reachable: true } }, [BOXES[0]]); // b2 gone
  expect(Object.keys(h.getSeries())).toEqual(['b1']);
});

test('seq is restored from the persisted log', () => {
  const h = createHealthHistory({ load: () => [{ seq: 41, boxId: 'b1', label: 'web-01', host: 'h1', t: 1, kind: 'down' }] });
  h.record({ b1: { reachable: true } }, [BOXES[0]]);  // seed
  h.record({ b1: { reachable: false } }, [BOXES[0]]); // next event
  expect(h.getEvents({}).events[0].seq).toBe(42);
});

test('onEvent listeners receive each emitted event (Phase-2 delivery seam)', () => {
  const got = [];
  const h = createHealthHistory({ onEvent: (e) => got.push(e.kind) });
  h.record({ b1: { reachable: true } }, [BOXES[0]]);
  h.record({ b1: { reachable: false } }, [BOXES[0]]);
  expect(got).toEqual(['down']);
});

test('confirmed Proxmox stopped is healthy-for-events and carries a stopped marker', () => {
  expect(sampleOf({ reachable: false, proxmoxState: 'stopped' }, 5)).toEqual({ t: 5, up: true, stopped: true });
});

test('running to stopped does not emit a false down event', () => {
  const history = createHealthHistory({});
  history.record({ b1: { reachable: true, proxmoxState: 'running' } }, [BOXES[0]]);
  history.record({ b1: { reachable: false, proxmoxState: 'stopped' } }, [BOXES[0]]);
  expect(history.getEvents({}).events).toEqual([]);
});

test('sampleOf carries keyChanged through', () => {
  const s = sampleOf({ reachable: false, hostKeyChanged: true }, 1000);
  expect(s.up).toBe(false);
  expect(s.keyChanged).toBe(true);
});

test('classifyTransitions emits key-changed on the falling edge and within-down transition', () => {
  const thresholds = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 };
  // up -> down with keyChanged
  let r = classifyTransitions({ t: 0, up: true }, { t: 1, up: false, keyChanged: true }, thresholds, initThresholdState());
  expect(r.events).toEqual([{ kind: 'key-changed' }]);
  // down (plain) -> down (keyChanged)
  r = classifyTransitions({ t: 0, up: false }, { t: 1, up: false, keyChanged: true }, thresholds, initThresholdState());
  expect(r.events).toEqual([{ kind: 'key-changed' }]);
  // keyChanged -> plain down
  r = classifyTransitions({ t: 0, up: false, keyChanged: true }, { t: 1, up: false }, thresholds, initThresholdState());
  expect(r.events).toEqual([{ kind: 'down' }]);
});
