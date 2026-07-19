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

test('one record() pass saves the events log once, not once per event', () => {
  let saves = 0;
  const h = createHealthHistory({ maxSamples: 10, maxEvents: 100, thresholds: TH, load: () => [], save: () => { saves += 1; } });
  const boxes = [{ id: 'a', host: 'a' }, { id: 'b', host: 'b' }];
  h.record({ a: { reachable: true }, b: { reachable: true } }, boxes); // seed, no events
  const before = saves;
  h.record({ a: { reachable: false, error: 'x' }, b: { reachable: false, error: 'x' } }, boxes); // two down events
  expect(saves - before).toBe(1);
});

const AGENT = { agentIdleSec: 45, sessionName: 'web' };
const withAgent = (over) => ({ reachable: true, metrics: { boxNowSec: 1000 }, sessions: [{ name: 'web', attached: false, activity: 1000, paneCmd: 'claude' }], ...over });

test('sampleOf marks a busy claude session working, an idle one waiting', () => {
  // active now → working
  expect(sampleOf(withAgent(), 5, AGENT).agent).toBe('working');
  // idle 60s (>= 45) → waiting
  const idle = withAgent({ sessions: [{ name: 'web', attached: false, activity: 940, paneCmd: 'claude' }] });
  expect(sampleOf(idle, 5, AGENT).agent).toBe('waiting');
});

test('sampleOf without a box clock reports presence with UNKNOWN idleness (never waiting, working, or absent)', () => {
  // A failed __META__ line must not erase the agent (a false agent-done) and
  // must not fabricate an observed idle state either: a fabricated 'working'
  // would make the recovery poll look like a genuine working->waiting edge and
  // fire a false agent-input one poll later. 'unknown' sits on neither side of
  // the input edge.
  const noMeta = withAgent({ metrics: undefined });
  expect(sampleOf(noMeta, 5, AGENT).agent).toBe('unknown');
});

test('a __META__ gap in the middle of a continuous wait fires no agent-input on recovery', () => {
  // waiting -> (clock missing: unknown) -> waiting must be silent end to end;
  // agent-done must still fire THROUGH an unknown sample (presence is
  // pane-based, not clock-based).
  const waiting = { up: true, agent: 'waiting', agentAttached: false };
  const unknown = { up: true, agent: 'unknown', agentAttached: false };
  const st0 = initThresholdState();
  const r1 = classifyTransitions(waiting, unknown, TH, st0);
  const r2 = classifyTransitions(unknown, waiting, TH, r1.state);
  expect([...r1.events, ...r2.events].filter((e) => e.kind.startsWith('agent-'))).toEqual([]);
  const gone = { up: true, agentAttached: false };
  expect(classifyTransitions(unknown, gone, TH, initThresholdState()).events).toContainEqual({ kind: 'agent-done' });
});

test('sampleOf ignores non-claude panes and the wrong session', () => {
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: false, activity: 1000, paneCmd: 'zsh' }] }), 5, AGENT).agent).toBeUndefined();
  expect(sampleOf(withAgent({ sessions: [{ name: 'other', attached: false, activity: 940, paneCmd: 'claude' }] }), 5, AGENT).agent).toBeUndefined();
  expect(sampleOf(withAgent(), 5, {}).agent).toBeUndefined(); // no sessionName → no agent state
});

test('sampleOf carries the configured session attached flag even without a claude pane', () => {
  // Attachment is a SESSION property: it must survive the poll where claude
  // exits, so agent-done suppression can honor it on both ends of the edge.
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: true, activity: 940, paneCmd: 'claude' }] }), 5, AGENT).agentAttached).toBe(true);
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: true, activity: 940, paneCmd: 'zsh' }] }), 5, AGENT).agentAttached).toBe(true);
  expect(sampleOf(withAgent({ sessions: [{ name: 'web', attached: false, activity: 940, paneCmd: 'zsh' }] }), 5, AGENT).agent).toBeUndefined();
});

test('classifyTransitions emits agent-input on working->waiting when detached, once', () => {
  const th = TH;
  const w = { up: true, agent: 'working', agentAttached: false };
  const idle = { up: true, agent: 'waiting', agentAttached: false };
  const r1 = classifyTransitions(w, idle, th, initThresholdState());
  expect(r1.events).toContainEqual({ kind: 'agent-input' });
  // still waiting → no re-fire
  const r2 = classifyTransitions(idle, idle, th, r1.state);
  expect(r2.events).not.toContainEqual({ kind: 'agent-input' });
});

test('classifyTransitions suppresses agent-input while attached', () => {
  const w = { up: true, agent: 'working', agentAttached: true };
  const idle = { up: true, agent: 'waiting', agentAttached: true };
  expect(classifyTransitions(w, idle, TH, initThresholdState()).events).not.toContainEqual({ kind: 'agent-input' });
});

test('classifyTransitions emits agent-done when the agent disappears on an up box, detached', () => {
  const w = { up: true, agent: 'working', agentAttached: false };
  const gone = { up: true, agentAttached: false };
  expect(classifyTransitions(w, gone, TH, initThresholdState()).events).toContainEqual({ kind: 'agent-done' });
  // suppressed if EITHER end of the edge was attached (watching = no ping)
  const wA = { up: true, agent: 'working', agentAttached: true };
  expect(classifyTransitions(wA, { up: true, agentAttached: false }, TH, initThresholdState()).events).not.toContainEqual({ kind: 'agent-done' });
  expect(classifyTransitions(w, { up: true, agentAttached: true }, TH, initThresholdState()).events).not.toContainEqual({ kind: 'agent-done' });
});

test('stopping a Proxmox box does not fire a false agent-done', () => {
  const w = { up: true, agent: 'working', agentAttached: false };
  const stoppedBox = { up: true, stopped: true };
  expect(classifyTransitions(w, stoppedBox, TH, initThresholdState()).events).toEqual([]);
});

test('agent kinds never fire on the first sample (no prev)', () => {
  const idle = { up: true, agent: 'waiting', agentAttached: false };
  expect(classifyTransitions(null, idle, TH, initThresholdState()).events).toEqual([]);
});
