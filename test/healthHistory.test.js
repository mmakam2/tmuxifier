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

const AGENT = { sessionName: 'web' };
const withAgent = (over) => ({ reachable: true, metrics: { boxNowSec: 1000 }, sessions: [{ name: 'web', attached: false, activity: 1000, paneCmd: 'claude' }], ...over });

test('sampleOf: a claude pane with no marker carries NO agent state, only presence', () => {
  // Hook-only statusing: pane output timing is never consulted, so a fresh
  // pane and a long-quiet pane read identically — no working/waiting guess.
  const busy = sampleOf(withAgent(), 5, AGENT);
  expect(busy.agent).toBeUndefined();
  expect(busy.agentPresent).toBe(true);
  const idle = withAgent({ sessions: [{ name: 'web', attached: false, activity: 940, paneCmd: 'claude' }] });
  const s = sampleOf(idle, 5, AGENT);
  expect(s.agent).toBeUndefined();
  expect(s.agentPresent).toBe(true);
});

test('sampleOf: no box clock changes nothing — the marker is the only source either way', () => {
  const noMeta = withAgent({ metrics: undefined });
  expect(sampleOf(noMeta, 5, AGENT).agent).toBeUndefined();
  expect(sampleOf(noMeta, 5, AGENT).agentPresent).toBe(true);
  const marked = withAgent({ metrics: undefined, agentMarks: { web: { state: 'working', ts: 990 } } });
  expect(sampleOf(marked, 5, AGENT).agent).toBe('working');
});

test('sampleOf ignores non-claude panes and the wrong session', () => {
  const zsh = sampleOf(withAgent({ sessions: [{ name: 'web', attached: false, activity: 1000, paneCmd: 'zsh' }] }), 5, AGENT);
  expect(zsh.agent).toBeUndefined();
  expect(zsh.agentPresent).toBeUndefined();
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

// The old anti-blip streak (AGENT_WORK_MIN_SAMPLES) is gone with the output
// heuristic: only a hook marker can produce 'working' now, so a single-poll
// working->waiting edge is always a real turn ending and must fire at once.
test('a single-poll working sample followed by waiting fires agent-input immediately', () => {
  const waiting = { up: true, agent: 'waiting', agentAttached: false };
  const working = { up: true, agent: 'working', agentAttached: false };
  let st = classifyTransitions(waiting, waiting, TH, initThresholdState()).state;
  st = classifyTransitions(waiting, working, TH, st).state;
  const end = classifyTransitions(working, waiting, TH, st);
  expect(end.events).toContainEqual({ kind: 'agent-input' });
});

// A hooked claude restarting in place: SessionEnd deletes the marker before
// the new claude's SessionStart rewrites it, so one poll can see the pane
// still running claude with no marker. Presence (agentPresent) gates
// agent-done so that gap stays silent; the claude actually exiting (no pane,
// no agentPresent) still fires.
test('a marker gap while the claude pane is still present fires no agent-done', () => {
  const marked = { up: true, agent: 'waiting', agentAttached: false, agentPresent: true };
  const gapped = { up: true, agentAttached: false, agentPresent: true };
  expect(classifyTransitions(marked, gapped, TH, initThresholdState()).events).toEqual([]);
  const gone = { up: true, agentAttached: false };
  expect(classifyTransitions(marked, gone, TH, initThresholdState()).events).toContainEqual({ kind: 'agent-done' });
});

test('sustained work followed by quiet still fires agent-input exactly once', () => {
  const waiting = { up: true, agent: 'waiting', agentAttached: false };
  const working = { up: true, agent: 'working', agentAttached: false };

  let st = classifyTransitions(waiting, waiting, TH, initThresholdState()).state;
  // A real task: output observed across consecutive polls.
  st = classifyTransitions(waiting, working, TH, st).state;
  const second = classifyTransitions(working, working, TH, st);
  expect(second.events).not.toContainEqual({ kind: 'agent-input' });
  // Now it goes quiet — the agent genuinely handed control back.
  const done = classifyTransitions(working, waiting, TH, second.state);
  expect(done.events).toContainEqual({ kind: 'agent-input' });
  // ...and does not repeat while it stays quiet.
  const still = classifyTransitions(waiting, waiting, TH, done.state);
  expect(still.events).not.toContainEqual({ kind: 'agent-input' });
});

test('a long task fires once, not once per poll', () => {
  const waiting = { up: true, agent: 'waiting', agentAttached: false };
  const working = { up: true, agent: 'working', agentAttached: false };
  let st = classifyTransitions(waiting, working, TH, initThresholdState()).state;
  let fired = 0;
  for (let poll = 0; poll < 10; poll += 1) {
    const r = classifyTransitions(working, working, TH, st);
    st = r.state;
    fired += r.events.filter((e) => e.kind === 'agent-input').length;
  }
  const end = classifyTransitions(working, waiting, TH, st);
  fired += end.events.filter((e) => e.kind === 'agent-input').length;
  expect(fired).toBe(1);
});

// A restart loses the sample series, so the first edge after it has no observed
// run behind it. That must still notify: dropping a real "waiting for input"
// is worse than one unconfirmed ping, and it is what the pre-existing
// fresh-state edge test relies on.
test('a working->waiting edge with no prior history still fires (restart tolerance)', () => {
  const working = { up: true, agent: 'working', agentAttached: false };
  const waiting = { up: true, agent: 'waiting', agentAttached: false };
  expect(classifyTransitions(working, waiting, TH, initThresholdState()).events)
    .toContainEqual({ kind: 'agent-input' });
});

test('sampleOf: the marker is the sole source of working/waiting, regardless of output timing', () => {
  // Marker says waiting although output is fresh (the parked-pane blip shape).
  const busy = withAgent({ agentMarks: { web: { state: 'waiting', ts: 990 } } });
  const s1 = sampleOf(busy, 5, AGENT);
  expect(s1.agent).toBe('waiting');
  expect(s1.agentPresent).toBe(true);
  // Marker says working although output has been quiet for ages.
  const quiet = withAgent({
    sessions: [{ name: 'web', attached: false, activity: 100, paneCmd: 'claude' }],
    agentMarks: { web: { state: 'working', ts: 90 } },
  });
  expect(sampleOf(quiet, 5, AGENT).agent).toBe('working');
});

test('sampleOf: a marker for another session is ignored, and a stale marker for an exited claude is inert', () => {
  const otherSession = withAgent({ agentMarks: { ops: { state: 'waiting', ts: 990 } } });
  const s = sampleOf(otherSession, 5, AGENT);
  expect(s.agent).toBeUndefined();          // no marker for THIS session → no state
  expect(s.agentPresent).toBe(true);
  const noClaude = withAgent({
    sessions: [{ name: 'web', attached: false, activity: 100, paneCmd: 'bash' }],
    agentMarks: { web: { state: 'working', ts: 90 } },
  });
  const dead = sampleOf(noClaude, 5, AGENT);
  expect(dead.agent).toBeUndefined();       // paneCmd gate: marker without a claude pane is inert
  expect(dead.agentPresent).toBeUndefined();
});
