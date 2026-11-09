import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { agentKindOf, sampleOf, deriveAgentState, classifyTransitions, initThresholdState, createHealthHistory } from '../src/server/healthHistory.js';
import { parseTmuxSessions, parseAgentMarks } from '../src/server/status.js';

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
  const marked = withAgent({ metrics: undefined, agentMarks: { web: { state: 'working', cause: 'prompt', ts: 990 } } });
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

const A = (agents) => ({ up: true, agents });
const E = (state, extra = {}) => ({ present: true, attached: false, state, ts: 1, ...extra });

test('agent edges run per session and carry the session name', () => {
  let st = initThresholdState();
  let r = classifyTransitions(A({ web: E('working'), 'web-2': E('working') }), A({ web: E('working'), 'web-2': E('working') }), TH, st); st = r.state;
  r = classifyTransitions(A({}), A({ web: E('blocked', { cause: 'permission' }), 'web-2': E('done') }), TH, st);
  expect(r.events).toEqual([{ kind: 'agent-blocked', session: 'web', cause: 'permission' }, { kind: 'agent-input', session: 'web-2' }]);
});

test('first appearance of a session emits nothing, even when it appears blocked', () => {
  const r = classifyTransitions(A({}), A({ web: E('blocked', { cause: 'permission' }) }), TH, initThresholdState());
  expect(r.events).toEqual([]);
});

test('a failed probe does not replace the previous map, so the box coming back is not a first appearance', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  st = classifyTransitions(A({ web: E('working') }), { up: false }, TH, st).state;   // no agents key
  const r = classifyTransitions({ up: false }, A({ web: E('done') }), TH, st);
  expect(r.events).toEqual([{ kind: 'up' }, { kind: 'agent-input', session: 'web' }]); // reachability edge first, as today
});

test('blocked → done without a working in between still fires agent-input', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('blocked') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ web: E('done') }), TH, st).events).toEqual([{ kind: 'agent-input', session: 'web' }]);
});

test('attached suppresses agent-blocked and agent-input but is not a seen mark (the state stays done)', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ web: E('done', { attached: true }) }), TH, st).events).toEqual([]);
});

test('a marker gap with the claude pane still present fires no agent-done; an exited claude does', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('done') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ web: { present: true, attached: false } }), TH, st).events).toEqual([]);
  expect(classifyTransitions(A({}), A({}), TH, st).events).toEqual([{ kind: 'agent-done', session: 'web' }]);
});

test('a persisting blocker emits once', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  let r = classifyTransitions(A({}), A({ web: E('blocked', { cause: 'question' }) }), TH, st); st = r.state;
  expect(r.events).toHaveLength(1);
  expect(classifyTransitions(A({}), A({ web: E('blocked', { cause: 'question' }) }), TH, st).events).toEqual([]);
});

const seeded = (agents) => ({ ...initThresholdState(), agents });

test('agent-input fires once on working to done when detached', () => {
  const r1 = classifyTransitions(A({}), A({ web: E('done') }), TH, seeded({ web: E('working') }));
  expect(r1.events).toContainEqual({ kind: 'agent-input', session: 'web' });
  const r2 = classifyTransitions(A({}), A({ web: E('done') }), TH, r1.state);
  expect(r2.events).toEqual([]);
});

test('multi-viewer tmux session (#{session_attached} >= 2) suppresses agent-input and agent-done', () => {
  const box = { id: 'b1', label: 'web-01', host: 'h1', sessionName: 'web' };
  const run = (viewers) => {
    const h = createHealthHistory({});
    const working = { reachable: true, sessions: parseTmuxSessions(`web:1:${viewers}:1000:claude\n`), agentMarks: { web: { state: 'working', cause: 'prompt', ts: 990 } } };
    const done = { reachable: true, sessions: parseTmuxSessions(`web:1:${viewers}:1005:claude\n`), agentMarks: { web: { state: 'ready', cause: 'stop', ts: 1005 } } };
    const exited = { reachable: true, sessions: parseTmuxSessions(`web:1:${viewers}:1010:zsh\n`) };
    h.record({ b1: working }, [box]);
    h.record({ b1: done }, [box]);
    h.record({ b1: exited }, [box]);
    return h.getEvents({}).events;
  };
  expect(run(2)).toEqual([]);
  // the same transitions with nobody attached DO fire, so the line above proves suppression
  expect(run(0).map((e) => e.kind).sort()).toEqual(['agent-done', 'agent-input']);
});

test('agent-done fires when claude exits on an up box, and either end attached silences it', () => {
  const mk = (viewers, cmd) => ({ reachable: true, sessions: parseTmuxSessions(`web:1:${viewers}:1010:${cmd}\n`) });
  const working = (viewers) => ({ reachable: true, sessions: parseTmuxSessions(`web:1:${viewers}:1000:claude\n`), agentMarks: { web: { state: 'working', cause: 'prompt', ts: 990 } } });
  const run = (v0, v1) => classifyTransitions(sampleOf(working(v0), 5, {}), sampleOf(mk(v1, 'zsh'), 5, {}), TH, seeded(sampleOf(working(v0), 5, {}).agents)).events;
  expect(run(0, 0)).toEqual([{ kind: 'agent-done', session: 'web', agent: 'claude' }]);
  expect(run(1, 0)).toEqual([]); // prev attached
  expect(run(0, 1)).toEqual([]); // next attached (session listed, pane now zsh)
  // and the session vanishing entirely still fires
  expect(classifyTransitions(A({}), A({}), TH, seeded({ web: E('working') })).events).toEqual([{ kind: 'agent-done', session: 'web' }]);
});

test('stopping then starting a Proxmox box fires no stale agent-done', () => {
  const ready = { reachable: true, sessions: parseTmuxSessions('web:1:0:1000:claude\n'), agentMarks: { web: { state: 'ready', cause: 'stop', ts: 990 } } };
  const samples = [ready, { proxmoxState: 'stopped' }, { reachable: true, sessions: [] }].map((x) => sampleOf(x, 5, {}));
  const st = classifyTransitions(null, samples[0], TH, initThresholdState()).state;
  let r = classifyTransitions(samples[0], samples[1], TH, st);
  expect(r.events.map((e) => e.kind)).not.toContain('agent-done');
  r = classifyTransitions(samples[1], samples[2], TH, r.state);
  expect(r.events.map((e) => e.kind)).not.toContain('agent-done');
});

test('a plain down -> up keeps the previous map, so a claude gone across a reboot fires agent-done', () => {
  const ready = sampleOf({ reachable: true, sessions: parseTmuxSessions('web:1:0:1000:claude\n'), agentMarks: { web: { state: 'ready', cause: 'stop', ts: 990 } } }, 5, {});
  const down = sampleOf({ reachable: false }, 5, {});
  const back = sampleOf({ reachable: true, sessions: [] }, 5, {});
  const st = classifyTransitions(null, ready, TH, initThresholdState()).state;
  const r = classifyTransitions(ready, down, TH, st);
  expect(classifyTransitions(down, back, TH, r.state).events.map((e) => e.kind)).toEqual(['up', 'agent-done']);
});

test('agent kinds never fire on the first sample (no prev)', () => {
  expect(classifyTransitions(null, A({ web: E('done') }), TH, initThresholdState()).events).toEqual([]);
});

// The old anti-blip streak is gone: only a hook marker produces 'working', so a
// single-poll working -> done edge is a real turn ending and fires at once.
test('a single-poll working sample followed by done fires agent-input immediately', () => {
  let st = classifyTransitions(A({}), A({ web: E('done') }), TH, initThresholdState()).state;
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ web: E('done') }), TH, st).events).toEqual([{ kind: 'agent-input', session: 'web' }]);
});

test('sustained work followed by quiet fires agent-input exactly once', () => {
  let st = classifyTransitions(A({}), A({ web: E('done') }), TH, initThresholdState()).state;
  st = classifyTransitions(A({}), A({ web: E('working') }), TH, st).state;
  const second = classifyTransitions(A({}), A({ web: E('working') }), TH, st);
  expect(second.events).toEqual([]);
  const done = classifyTransitions(A({}), A({ web: E('done') }), TH, second.state);
  expect(done.events).toEqual([{ kind: 'agent-input', session: 'web' }]);
  expect(classifyTransitions(A({}), A({ web: E('done') }), TH, done.state).events).toEqual([]);
});

test('a long task fires once, not once per poll', () => {
  let st = classifyTransitions(A({}), A({ web: E('working') }), TH, initThresholdState()).state;
  let fired = 0;
  for (let poll = 0; poll < 10; poll += 1) {
    const r = classifyTransitions(A({}), A({ web: E('working') }), TH, st);
    st = r.state;
    fired += r.events.length;
  }
  fired += classifyTransitions(A({}), A({ web: E('done') }), TH, st).events.length;
  expect(fired).toBe(1);
});

// Was "no prior history still fires (restart tolerance)". Per session, an edge
// needs a previous entry: with one (working) a done fires; with none it is a
// first appearance and stays silent.
test('first appearance as done emits nothing, but a previous working entry makes done fire', () => {
  expect(classifyTransitions(A({}), A({ web: E('done') }), TH, initThresholdState()).events).toEqual([]);
  expect(classifyTransitions(A({}), A({ web: E('done') }), TH, seeded({ web: E('working') })).events)
    .toEqual([{ kind: 'agent-input', session: 'web' }]);
});

test('sampleOf: the marker is the sole source of working/waiting, regardless of output timing', () => {
  // Marker says waiting although output is fresh (the parked-pane blip shape).
  const busy = withAgent({ agentMarks: { web: { state: 'ready', cause: 'stop', ts: 990 } } });
  const s1 = sampleOf(busy, 5, AGENT);
  expect(s1.agent).toBe('done');
  expect(s1.agentPresent).toBe(true);
  // Marker says working although output has been quiet for ages.
  const quiet = withAgent({
    sessions: [{ name: 'web', attached: false, activity: 100, paneCmd: 'claude' }],
    agentMarks: { web: { state: 'working', cause: 'prompt', ts: 90 } },
  });
  expect(sampleOf(quiet, 5, AGENT).agent).toBe('working');
});

test('sampleOf: a marker for another session is ignored, and a stale marker for an exited claude is inert', () => {
  const otherSession = withAgent({ agentMarks: { ops: { state: 'ready', cause: 'stop', ts: 990 } } });
  const s = sampleOf(otherSession, 5, AGENT);
  expect(s.agent).toBeUndefined();          // no marker for THIS session → no state
  expect(s.agentPresent).toBe(true);
  const noClaude = withAgent({
    sessions: [{ name: 'web', attached: false, activity: 100, paneCmd: 'bash' }],
    agentMarks: { web: { state: 'working', cause: 'prompt', ts: 90 } },
  });
  const dead = sampleOf(noClaude, 5, AGENT);
  expect(dead.agent).toBeUndefined();       // paneCmd gate: marker without a claude pane is inert
  expect(dead.agentPresent).toBeUndefined();
});

test('deriveAgentState: start is idle, stop is done until seen, blocked and working pass through', () => {
  expect(deriveAgentState({ state: 'working', cause: 'prompt', ts: 10 })).toBe('working');
  expect(deriveAgentState({ state: 'blocked', cause: 'permission', ts: 10 })).toBe('blocked');
  expect(deriveAgentState({ state: 'ready', cause: 'start', ts: 10 })).toBe('idle');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 })).toBe('done');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 }, 9)).toBe('done');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 }, 10)).toBe('idle');
});

test('sampleOf builds a per-session agents map and keeps the legacy agent field for the configured session', () => {
  const status = { reachable: true, tmux: true,
    sessions: [
      { name: 'web', windows: 1, attached: false, paneCmd: 'claude' },
      { name: 'web-2', windows: 1, attached: true, paneCmd: 'claude' },
      { name: 'build', windows: 1, attached: false, paneCmd: 'zsh' },
      { name: 'bad name', windows: 1, attached: false, paneCmd: 'claude' },
      { name: 'nomark', windows: 1, attached: false, paneCmd: 'claude' },
    ],
    agentMarks: { web: { state: 'ready', cause: 'stop', ts: 50 }, 'web-2': { state: 'blocked', cause: 'permission', ts: 60 }, 'bad name': { state: 'working', cause: 'prompt', ts: 1 }, stale: { state: 'working', cause: 'prompt', ts: 1 } } };
  const s = sampleOf(status, 1, { sessionName: 'web', seenOf: (name) => (name === 'web' ? 50 : undefined) });
  expect(s.agents).toEqual({
    web: { present: true, agent: 'claude', attached: false, state: 'idle', cause: 'stop', ts: 50 },
    'web-2': { present: true, agent: 'claude', attached: true, state: 'blocked', cause: 'permission', ts: 60 },
    nomark: { present: true, agent: 'claude', attached: false },
    build: { present: false, attached: false },
  });
  expect(s.agent).toBe('idle');
  expect(s.agentPresent).toBe(true);
});

test('sampleOf: a failed probe carries no agents map at all; an empty session list carries an empty one', () => {
  expect('agents' in sampleOf({ reachable: false }, 1)).toBe(false);
  expect(sampleOf({ reachable: true, sessions: [] }, 1).agents).toEqual({});
});

function memSeenStore(init = {}) { let data = init; return { load: () => data, save: (m) => { data = m; }, whenIdle: async () => {}, get data() { return data; } }; }
const claudeStatus = (marks, sessions = ['web']) => ({ reachable: true, tmux: true, sessions: sessions.map((n) => ({ name: n, windows: 1, attached: false, paneCmd: 'claude' })), agentMarks: marks });

test('markSeen turns done into idle on the next record and persists; a ts ahead of the marker is refused', () => {
  const store = memSeenStore();
  const h = createHealthHistory({ seenStore: store, now: () => 1 });
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }) }, [box]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('done');
  expect(h.markSeen('b1', 'web', 101)).toBe(false);
  expect(h.markSeen('b1', 'nope', 100)).toBe(false);
  expect(h.markSeen('b1', 'web', 100)).toBe(true);
  expect(store.data).toEqual({ b1: { web: 100 } });
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }) }, [box]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('idle');
});

test('seen survives a failed probe and a non-claude pane, and is dropped only when the session is gone from a successful listing', () => {
  const store = memSeenStore({ b1: { web: 100 } });
  const h = createHealthHistory({ seenStore: store });
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: { reachable: false } }, [box]);
  expect(store.data).toEqual({ b1: { web: 100 } });
  h.record({ b1: { reachable: true, sessions: [{ name: 'web', windows: 1, attached: false, paneCmd: 'zsh' }] } }, [box]);
  expect(store.data).toEqual({ b1: { web: 100 } });
  h.record({ b1: { reachable: true, sessions: [] } }, [box]);
  expect(store.data).toEqual({ b1: {} });
});

test('a seen session that finishes a new turn is done again, and the event carries the session', () => {
  const store = memSeenStore({ b1: { web: 100 } });
  const seen = [];
  const h = createHealthHistory({ seenStore: store, onEvent: (e) => seen.push(e) });
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: claudeStatus({ web: { state: 'working', cause: 'prompt', ts: 150 } }) }, [box]);
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 200 } }) }, [box]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('done');
  expect(seen.map((e) => [e.kind, e.session])).toEqual([['agent-input', 'web']]);
});

test('a persisted agent-blocked event carries session and cause; whenIdle resolves without a store', async () => {
  const h = createHealthHistory();
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: claudeStatus({ web: { state: 'working', cause: 'prompt', ts: 150 } }) }, [box]);
  h.record({ b1: claudeStatus({ web: { state: 'blocked', cause: 'permission', ts: 160 } }) }, [box]);
  const ev = h.getEvents().events.find((e) => e.kind === 'agent-blocked');
  expect(ev).toMatchObject({ boxId: 'b1', session: 'web', cause: 'permission' });
  await expect(h.whenIdle()).resolves.toBeUndefined();
});

test('a removed box drops its seen entry', () => {
  const store = memSeenStore({ b1: { web: 100 }, b2: { web: 5 } });
  const h = createHealthHistory({ seenStore: store });
  h.record({ b2: claudeStatus({}) }, [{ id: 'b2', host: 'h', sessionName: 'web' }]);
  expect(store.data).toEqual({ b2: { web: 5 } });
});

// T7c: a watermark loaded at boot applies to the very first record() — the
// restart must not flash `done` for a turn the operator already saw.
test('a watermark loaded from seenStore.load() yields idle on the FIRST record of a ready/stop marker', () => {
  const store = memSeenStore({ b1: { web: 100 } });
  const h = createHealthHistory({ seenStore: store });
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }) }, [{ id: 'b1', host: 'h', sessionName: 'web' }]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('idle');
});

// A box listed in `boxes` with no status this pass (the Host Shell sampler
// losing its race) is skipped, not pruned: its seen entry and series survive.
test('a listed box with no status this pass keeps its seen entry and series', () => {
  const store = memSeenStore({ b1: { web: 100 } });
  const h = createHealthHistory({ seenStore: store });
  const box = { id: 'b1', host: 'h', sessionName: 'web' };
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }) }, [box]);
  h.record({}, [box]);
  expect(store.data).toEqual({ b1: { web: 100 } });
  expect(h.getSeries('b1')).toHaveLength(1);
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }) }, [box]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('idle');
});

// M6: session names are box-controlled; prototype keys must neither vanish
// nor poison the agents map.
test('sampleOf keeps __proto__ and constructor sessions as own agents entries', () => {
  const marks = parseAgentMarksForTest();
  const s = sampleOf({ reachable: true, sessions: [
    { name: '__proto__', windows: 1, attached: false, paneCmd: 'claude' },
    { name: 'constructor', windows: 1, attached: false, paneCmd: 'claude' },
    { name: 'web', windows: 1, attached: false, paneCmd: 'claude' },
  ], agentMarks: marks }, 1, { sessionName: '__proto__' });
  expect(Object.keys(s.agents).sort()).toEqual(['__proto__', 'constructor', 'web']);
  expect(Object.hasOwn(s.agents, '__proto__')).toBe(true);
  expect(s.agents.__proto__).toMatchObject({ present: true, state: 'working', ts: 10 });
  // `constructor` has no marker: no inherited Object.prototype.constructor read as one.
  expect(s.agents.constructor).toEqual({ present: true, agent: 'claude', attached: false });
  expect(s.agents.web.state).toBe('done');
  expect(s.agent).toBe('working');
  // The map round-trips through JSON (the /api/status boundary) intact.
  expect(Object.keys(JSON.parse(JSON.stringify(s.agents))).sort()).toEqual(['__proto__', 'constructor', 'web']);
});

function parseAgentMarksForTest() {
  return parseAgentMarks('__AGENT__ __proto__:working:10:prompt\n__AGENT__ web:ready:11:stop\n');
}

test('agentKindOf: claude and opencode panes are agents, shells and node are not', () => {
  expect(agentKindOf('claude')).toBe('claude'); expect(agentKindOf('claude-code')).toBe('claude');
  expect(agentKindOf('opencode')).toBe('opencode'); expect(agentKindOf('opencode-x')).toBe('opencode');
  expect(agentKindOf('node')).toBeNull(); expect(agentKindOf('zsh')).toBeNull(); expect(agentKindOf('')).toBeNull();
});

test('sampleOf: an opencode pane with a marker carries state and agent: opencode', () => {
  const s = sampleOf(withAgent({
    sessions: [{ name: 'web', attached: false, activity: 1000, paneCmd: 'opencode' }],
    agentMarks: { web: { state: 'blocked', cause: 'permission', ts: 990 } },
  }), 5, AGENT);
  expect(s.agents.web).toEqual({ present: true, agent: 'opencode', state: 'blocked', cause: 'permission', ts: 990, attached: false });
  expect(s.agent).toBe('blocked');
});

test('agent events carry the agent kind, including agent-done after the pane is gone', () => {
  const mk = (cmd, mark) => sampleOf({ reachable: true, sessions: [{ name: 'web', attached: false, paneCmd: cmd }], agentMarks: mark }, 5, AGENT);
  const a = mk('opencode', { web: { state: 'working', cause: 'prompt', ts: 1 } });
  const b = mk('opencode', { web: { state: 'blocked', cause: 'permission', ts: 2 } });
  let st = initThresholdState();
  st = classifyTransitions(null, a, TH, st).state;
  const r = classifyTransitions(a, b, TH, st); st = r.state;
  expect(r.events).toEqual([{ kind: 'agent-blocked', session: 'web', cause: 'permission', agent: 'opencode' }]);
  const gone = { up: true, agents: {} };
  expect(classifyTransitions(b, gone, TH, st).events).toEqual([{ kind: 'agent-done', session: 'web', agent: 'opencode' }]);
});

test('record() keeps the agent kind on emitted and persisted agent events, and none on others', () => {
  const run = (cmd) => {
    const emitted = [];
    const h = createHealthHistory({ onEvent: (e) => emitted.push(e) });
    const box = { id: 'b1', host: 'h', sessionName: 'web' };
    const st = (marks) => ({ reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1, attached: false, paneCmd: cmd }], agentMarks: marks });
    h.record({ b1: st({ web: { state: 'working', cause: 'prompt', ts: 150 } }) }, [box]);
    h.record({ b1: st({ web: { state: 'blocked', cause: 'permission', ts: 160 } }) }, [box]);
    h.record({ b1: { reachable: false, error: 'x' } }, [box]);
    const persisted = h.getEvents().events.find((e) => e.kind === 'agent-blocked');
    return { emitted: emitted.find((e) => e.kind === 'agent-blocked'), persisted, down: emitted.find((e) => e.kind === 'down') };
  };
  for (const kind of ['opencode', 'claude']) {
    const r = run(kind);
    for (const ev of [r.emitted, r.persisted]) expect(ev).toMatchObject({ agent: kind, session: 'web', cause: 'permission' });
  }
  expect('agent' in run('claude').down).toBe(false);
});

test('agentKindOf: codex and pi are agents, lookalikes are not', () => {
  expect(agentKindOf('codex')).toBe('codex'); expect(agentKindOf('codex-x')).toBe('codex');
  expect(agentKindOf('pi')).toBe('pi'); expect(agentKindOf('pi-dev')).toBe('pi');
  expect(agentKindOf('pip')).toBeNull(); expect(agentKindOf('node')).toBeNull();
});

test('agentKindOf: agy is an agent, lookalikes are not', () => {
  expect(agentKindOf('agy')).toBe('agy'); expect(agentKindOf('agy-x')).toBe('agy');
  expect(agentKindOf('agyx')).toBeNull(); expect(agentKindOf('agy2')).toBeNull();
  expect(agentKindOf('mcp-agy')).toBeNull();
});

test('OSC reporter asset agent_kind: agy matches like agentKindOf', () => {
  const asset = new URL('../src/server/assets/tmuxifier-osc-reporter.py', import.meta.url).pathname;
  const script = 'import importlib.util,json,sys\nsys.dont_write_bytecode=True\n'
    + 'spec=importlib.util.spec_from_file_location("r",sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n'
    + "print(json.dumps([m.agent_kind(c, '/nonexistent') for c in ['agy','agy-x','agyx','mcp-agy']]))";
  expect(JSON.parse(execFileSync('python3', ['-c', script, asset], { encoding: 'utf8' }))).toEqual(['agy', 'agy', null, null]);
});

test('agentKindOf: pinned to the OSC reporter asset OSC_AGENTS keys', () => {
  const asset = new URL('../src/server/assets/tmuxifier-osc-reporter.py', import.meta.url).pathname;
  const script = 'import importlib.util,json,sys\nsys.dont_write_bytecode=True\n'
    + 'spec=importlib.util.spec_from_file_location("r",sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n'
    + 'print(json.dumps(sorted(m.OSC_AGENTS)))';
  const keys = JSON.parse(execFileSync('python3', ['-c', script, asset], { encoding: 'utf8' }));
  expect(keys).toEqual(['agy', 'codex', 'opencode', 'pi']);
  for (const k of keys) expect(agentKindOf(k)).toBe(k);
});

// --- recordAgents: the real-time path (a marker change between two sweeps) ---

const RT_BOX = { id: 'b1', label: 'web-01', host: 'h1', sessionName: 'web' };
const mark = (state, cause, ts) => ({ web: { state, cause, ts } });
function rtHistory(extra = {}) {
  let t = 1000;
  const saved = [];
  const pushed = [];
  const h = createHealthHistory({ now: () => t, save: (e) => saved.push(e.length), onEvent: (e) => pushed.push(e), ...extra });
  return { h, saved, pushed, tick: (ms) => { t += ms; } };
}

test('recordAgents rewrites the latest sample in place and emits the edge at once', () => {
  const { h, saved, pushed, tick } = rtHistory();
  h.record({ b1: { ...claudeStatus(mark('working', 'prompt', 100)), metrics: { memTotalKb: 100, memAvailKb: 40 } } }, [RT_BOX]);
  tick(3000);
  expect(h.recordAgents(RT_BOX, claudeStatus(mark('blocked', 'permission', 101)))).toBe(true);
  const ring = h.getSeries('b1');
  // Not a new sample: the series keeps the sweep's cadence, time and metrics.
  expect(ring).toHaveLength(1);
  expect(ring[0].t).toBe(1000);
  expect(ring[0].memPct).toBe(60);
  expect(ring[0].agents.web).toMatchObject({ state: 'blocked', cause: 'permission', ts: 101, agent: 'claude' });
  expect(ring[0].agent).toBe('blocked');
  const { events } = h.getEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'agent-blocked', boxId: 'b1', label: 'web-01', session: 'web', cause: 'permission', agent: 'claude', t: 4000 });
  expect(pushed).toHaveLength(1);
  expect(saved).toEqual([1]);
});

test('the sweep after a recordAgents sees the same state and does not notify twice', () => {
  const { h, tick } = rtHistory();
  h.record({ b1: claudeStatus(mark('working', 'prompt', 100)) }, [RT_BOX]);
  h.recordAgents(RT_BOX, claudeStatus(mark('ready', 'stop', 105)));
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-input']);
  tick(30000);
  h.record({ b1: claudeStatus(mark('ready', 'stop', 105)) }, [RT_BOX]);
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-input']);
  expect(h.getSeries('b1')).toHaveLength(2);
});

test('recordAgents needs a sweep baseline and an up, running box', () => {
  const { h } = rtHistory();
  // Never swept: there is no sample to rewrite and no previous state to edge from.
  expect(h.recordAgents(RT_BOX, claudeStatus(mark('blocked', 'permission', 1)))).toBe(false);
  expect(h.getSeries('b1')).toEqual([]);
  h.record({ b1: { reachable: false } }, [RT_BOX]);
  expect(h.recordAgents(RT_BOX, claudeStatus(mark('blocked', 'permission', 1)))).toBe(false);
  h.record({ b1: { reachable: false, proxmoxState: 'stopped' } }, [RT_BOX]);
  expect(h.recordAgents(RT_BOX, claudeStatus(mark('blocked', 'permission', 1)))).toBe(false);
  expect(h.getEvents().events.filter((e) => e.kind.startsWith('agent'))).toEqual([]);
});

test('recordAgents ignores a status whose session listing is unknown', () => {
  const { h } = rtHistory();
  h.record({ b1: claudeStatus(mark('working', 'prompt', 100)) }, [RT_BOX]);
  // No `sessions` key = tmux could not be listed. That is not "every session
  // ended", so nothing may change and no agent-done may fire.
  expect(h.recordAgents(RT_BOX, { reachable: true, agentMarks: mark('ready', 'stop', 101) })).toBe(false);
  expect(h.getSeries('b1')[0].agents.web.state).toBe('working');
  expect(h.getEvents().events).toEqual([]);
});

test('recordAgents keeps the suppression and first-appearance rules', () => {
  const { h } = rtHistory();
  const attached = (marks) => ({ ...claudeStatus(marks), sessions: [{ name: 'web', windows: 1, attached: true, paneCmd: 'claude' }] });
  h.record({ b1: attached(mark('working', 'prompt', 100)) }, [RT_BOX]);
  h.recordAgents(RT_BOX, attached(mark('blocked', 'permission', 101)));
  expect(h.getEvents().events).toEqual([]); // the operator is looking at it
  // A session that was not there at the last sample has no previous state.
  h.recordAgents(RT_BOX, claudeStatus({ web: { state: 'working', cause: 'prompt', ts: 102 }, two: { state: 'blocked', cause: 'question', ts: 103 } }, ['web', 'two']));
  expect(h.getEvents().events).toEqual([]);
  // ...but from then on it edges like any other.
  h.recordAgents(RT_BOX, claudeStatus({ web: { state: 'working', cause: 'prompt', ts: 102 }, two: { state: 'working', cause: 'unblock', ts: 104 } }, ['web', 'two']));
  h.recordAgents(RT_BOX, claudeStatus({ web: { state: 'working', cause: 'prompt', ts: 102 }, two: { state: 'ready', cause: 'stop', ts: 105 } }, ['web', 'two']));
  expect(h.getEvents().events.map((e) => [e.kind, e.session])).toEqual([['agent-input', 'two']]);
});

test('recordAgents reports an agent that exited', () => {
  const { h } = rtHistory();
  h.record({ b1: claudeStatus(mark('working', 'prompt', 100)) }, [RT_BOX]);
  const shell = { reachable: true, tmux: true, sessions: [{ name: 'web', windows: 1, attached: false, paneCmd: 'zsh' }] };
  expect(h.recordAgents(RT_BOX, shell)).toBe(true);
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-done']);
  expect(h.getSeries('b1')[0]).not.toHaveProperty('agent');
  expect(h.getSeries('b1')[0]).not.toHaveProperty('agentPresent');
});

test('recordAgents leaves the metric thresholds and every other box alone', () => {
  const { h, tick } = rtHistory();
  const hot = (marks) => ({ ...claudeStatus(marks), metrics: { cpuPct: 99 } });
  const b2 = { id: 'b2', label: 'db-01', host: 'h2' };
  const cool = { reachable: true, tmux: true, sessions: [], metrics: { cpuPct: 5 } };
  h.record({ b1: { ...claudeStatus(mark('working', 'prompt', 100)), metrics: { cpuPct: 5 } }, b2: cool }, [RT_BOX, b2]);
  tick(30000);
  h.record({ b1: hot(mark('working', 'prompt', 100)), b2: cool }, [RT_BOX, b2]); // first over-sample: no event yet
  // Three marker changes inside the interval. None is a CPU sample: the streak
  // must neither reach two (a false alarm) nor reset (a missed one).
  h.recordAgents(RT_BOX, claudeStatus(mark('blocked', 'permission', 101)));
  h.recordAgents(RT_BOX, claudeStatus(mark('working', 'unblock', 102)));
  h.recordAgents(RT_BOX, claudeStatus(mark('ready', 'stop', 103)));
  expect(h.getEvents().events.filter((e) => e.kind === 'threshold')).toEqual([]);
  expect(h.getSeries('b1').at(-1).cpuPct).toBe(99);
  expect(h.getSeries('b2')).toHaveLength(2); // a single-box update prunes nobody
  tick(30000);
  h.record({ b1: hot(mark('ready', 'stop', 103)), b2: cool }, [RT_BOX, b2]);
  expect(h.getEvents().events.filter((e) => e.kind === 'threshold')).toHaveLength(1);
});

test('recordAgents drops the seen watermark of a session that is gone', () => {
  const store = memSeenStore({ b1: { web: 100, old: 50 } });
  const h = createHealthHistory({ seenStore: store, now: () => 1 });
  h.record({ b1: claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }, ['web', 'old']) }, [RT_BOX]);
  h.recordAgents(RT_BOX, claudeStatus({ web: { state: 'ready', cause: 'stop', ts: 100 } }, ['web']));
  expect(store.data).toEqual({ b1: { web: 100 } });
  // The watermark is honoured on this path too.
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('idle');
});

test('markSeen turns done into idle immediately, for every client reading the series', () => {
  const store = memSeenStore();
  const { h } = rtHistory({ seenStore: store });
  h.record({ b1: claudeStatus(mark('ready', 'stop', 100)) }, [RT_BOX]);
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('done');
  expect(h.markSeen('b1', 'web', 100)).toBe(true);
  const last = h.getSeries('b1').at(-1);
  expect(last.agents.web.state).toBe('idle');
  expect(last.agent).toBe('idle');
  expect(h.getSeries('b1')).toHaveLength(1);
  // The acknowledged turn is the baseline now: a later prompt still notifies.
  h.recordAgents(RT_BOX, claudeStatus(mark('blocked', 'permission', 110)));
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-blocked']);
});

test('markSeen below the marker ts leaves done alone', () => {
  const { h } = rtHistory({ seenStore: memSeenStore() });
  h.record({ b1: claudeStatus(mark('ready', 'stop', 100)) }, [RT_BOX]);
  expect(h.markSeen('b1', 'web', 90)).toBe(true); // an older turn's ack, accepted and inert
  expect(h.getSeries('b1').at(-1).agents.web.state).toBe('done');
});
