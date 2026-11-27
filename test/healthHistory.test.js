import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { agentKindOf as agentKindOfModule } from '../src/server/agentKind.js';
import {
  agentKindOf, sampleOf, onScreenPanes, agentEdges, deriveAgentState, classifyTransitions, initThresholdState, createHealthHistory,
} from '../src/server/healthHistory.js';
import { parseTmuxSessions, parseTmuxWindows, attachWindows, parseTmuxPanes, parsePaneMarks } from '../src/server/status.js';


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


// --- agents per pane: the sample ---------------------------------------------

// Pane markers as parsePaneMarks returns them: null-prototype, keyed by pane id.
const marks = (o) => Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(o).map(([pane, [state, cause, ts, session = 'main']]) => [pane, { session, state, cause, ts }]),
));

// One attached session `main`: window 1 `api` in the background holding a
// blocked claude, window 2 `frontend` in front holding a claude, a codex and a shell.
const status = (over = {}) => ({
  reachable: true, tmux: true,
  sessions: [{ name: 'main', windows: 2, attached: true, activity: 0, paneCmd: 'zsh',
    windowList: [{ id: '@0', index: 1, name: 'api', active: false }, { id: '@1', index: 2, name: 'frontend', active: true }] }],
  panes: [
    { session: 'main', windowId: '@0', pane: '%0', index: 1, active: true, zoomed: false, cmd: 'claude' },
    { session: 'main', windowId: '@1', pane: '%1', index: 1, active: true, zoomed: false, cmd: 'claude' },
    { session: 'main', windowId: '@1', pane: '%2', index: 2, active: false, zoomed: false, cmd: 'codex' },
    { session: 'main', windowId: '@1', pane: '%3', index: 3, active: false, zoomed: false, cmd: 'zsh' },
  ],
  paneMarks: marks({ '%0': ['blocked', 'permission', 100], '%1': ['ready', 'stop', 200] }),
  ...over,
});
// The same box with window 1 in front instead.
const apiInFront = (over = {}) => {
  const s = status(over);
  s.sessions[0].windowList = [{ id: '@0', index: 1, name: 'api', active: true }, { id: '@1', index: 2, name: 'frontend', active: false }];
  return s;
};

test('builds one entry per agent pane', () => {
  const s = sampleOf(status(), 1, { seenOf: (p) => (p === '%1' ? 200 : undefined) });
  expect(Object.keys(s.agents)).toEqual(['%0', '%1', '%2']);
  expect(s.agents['%0']).toEqual({ session: 'main', windowId: '@0', windowIndex: 1, windowName: 'api', paneIndex: 1,
    agent: 'claude', state: 'blocked', cause: 'permission', ts: 100, visible: false, focused: false, attached: true });
  expect(s.agents['%1']).toMatchObject({ state: 'idle', visible: true, focused: true });
  expect(s.agents['%2']).toMatchObject({ agent: 'codex', visible: true, focused: false });
  expect('state' in s.agents['%2']).toBe(false);
  expect('agent' in s).toBe(false);
  expect('agentPresent' in s).toBe(false);
  expect('agentAttached' in s).toBe(false);
  // The map is null-prototype, like every map keyed by box output.
  expect(Object.getPrototypeOf(s.agents)).toBe(null);
});

test('hides a pane behind a zoomed neighbour', () => {
  const z = status();
  z.panes = z.panes.map((p) => (p.windowId === '@1' ? { ...p, zoomed: true } : p));
  const s = sampleOf(z, 1);
  expect(s.agents['%1'].visible).toBe(true);
  expect(s.agents['%2'].visible).toBe(false);
  expect([...onScreenPanes(z)].sort()).toEqual(['%1']);
});

test('on screen means visible in an attached session, and covers shell panes too', () => {
  expect([...onScreenPanes(status())].sort()).toEqual(['%1', '%2', '%3']);
  const detached = status();
  detached.sessions[0].attached = false;
  expect([...onScreenPanes(detached)]).toEqual([]);
  const st = status(); delete st.panes;
  expect([...onScreenPanes(st)]).toEqual([]);
  expect([...onScreenPanes(undefined)]).toEqual([]);
});

test('carries no agents key when sessions are listed but panes are not', () => {
  const st = status(); delete st.panes;
  expect('agents' in sampleOf(st, 1)).toBe(false);
});

test('an empty session list is an empty map', () => {
  expect(sampleOf({ reachable: true, tmux: false, sessions: [], panes: [] }, 1).agents).toEqual({});
  // No sessions at all also means no panes, whatever the pane listing said.
  expect(sampleOf({ reachable: true, tmux: true, sessions: [] }, 1).agents).toEqual({});
});

test('a failed probe carries no agents map at all', () => {
  expect('agents' in sampleOf({ reachable: false }, 1)).toBe(false);
});

test('omits a pane whose window row is missing', () => {
  const st = status(); st.sessions[0].windowList = st.sessions[0].windowList.slice(1);
  expect(Object.keys(sampleOf(st, 1).agents)).toEqual(['%1', '%2']);
});

test('omits a pane whose session row is missing or whose session name cannot be targeted', () => {
  const st = status();
  st.panes.push({ session: 'gone', windowId: '@5', pane: '%5', index: 1, active: true, zoomed: false, cmd: 'claude' });
  st.sessions.push({ name: 'bad name', windows: 1, attached: false, activity: 0, paneCmd: 'claude', windowList: [{ id: '@6', index: 1, name: 'x', active: true }] });
  st.panes.push({ session: 'bad name', windowId: '@6', pane: '%6', index: 1, active: true, zoomed: false, cmd: 'claude' });
  expect(Object.keys(sampleOf(st, 1).agents)).toEqual(['%0', '%1', '%2']);
});

test('a pane listed under two grouped sessions is one entry, under the session its marker names', () => {
  const st = status();
  st.sessions.push({ name: 'twin', windows: 2, attached: false, activity: 0, paneCmd: 'zsh', windowList: [{ id: '@0', index: 1, name: 'api', active: true }] });
  st.panes.unshift({ session: 'twin', windowId: '@0', pane: '%0', index: 1, active: true, zoomed: false, cmd: 'claude' });
  const a = sampleOf(st, 1).agents['%0'];
  expect(a).toMatchObject({ session: 'main', visible: false, attached: true });   // main's flags, not twin's
  // With no marker, the first session listing the pane is the one.
  const nomark = { ...st, paneMarks: marks({}) };
  expect(sampleOf(nomark, 1).agents['%0']).toMatchObject({ session: 'twin', visible: true, focused: true, attached: false });
});

test('a session named like an Object.prototype key is an ordinary session', () => {
  const st = {
    reachable: true, tmux: true,
    sessions: [{ name: '__proto__', windows: 1, attached: false, activity: 0, paneCmd: 'claude', windowList: [{ id: '@0', index: 0, name: 'w', active: true }] },
      { name: 'constructor', windows: 1, attached: false, activity: 0, paneCmd: 'claude', windowList: [{ id: '@1', index: 0, name: 'w', active: true }] }],
    panes: [{ session: '__proto__', windowId: '@0', pane: '%0', index: 0, active: true, zoomed: false, cmd: 'claude' },
      { session: 'constructor', windowId: '@1', pane: '%1', index: 0, active: true, zoomed: false, cmd: 'claude' }],
    paneMarks: marks({ '%0': ['working', 'prompt', 10, '__proto__'] }),
  };
  const s = sampleOf(st, 1);
  expect(s.agents['%0']).toMatchObject({ session: '__proto__', state: 'working', ts: 10 });
  expect(s.agents['%1']).toMatchObject({ session: 'constructor' });
  expect('state' in s.agents['%1']).toBe(false);
  expect(Object.keys(JSON.parse(JSON.stringify(s.agents)))).toEqual(['%0', '%1']);
});

test('the marker is the sole source of state, and a marker for a shell pane is inert', () => {
  const st = status({ paneMarks: marks({ '%0': ['working', 'prompt', 90], '%3': ['blocked', 'question', 95] }) });
  const s = sampleOf(st, 1);
  expect(s.agents['%0']).toMatchObject({ state: 'working', cause: 'prompt', ts: 90 });
  expect('%3' in s.agents).toBe(false);
  // A ready/start is idle: nothing finished, so nothing to acknowledge.
  expect(sampleOf(status({ paneMarks: marks({ '%1': ['ready', 'start', 5] }) }), 1).agents['%1'].state).toBe('idle');
});

// The parsers and sampleOf together, over a probe's own output.
const fromProbe = (stdout) => {
  const sessions = attachWindows(parseTmuxSessions(stdout), parseTmuxWindows(stdout));
  const { panes, complete } = parseTmuxPanes(stdout);
  const out = { reachable: true, tmux: true, sessions };
  if (complete) out.panes = panes;
  const pm = parsePaneMarks(stdout);
  if (pm) out.paneMarks = pm;
  return out;
};

test('a probe\'s rows become pane entries: one session-wide marker speaks for both agent panes', () => {
  const out = [
    'web:1:1:1000:claude',
    '__WIN__ web:0:@0:1:code',
    '__PANE__ web:@0:%1:0:1:0:claude',
    '__PANE__ web:@0:%2:1:0:0:claude',
    '__AGENT__ web:ready:200:stop',
  ].join('\n');
  const s = sampleOf(fromProbe(out), 1);
  expect(s.agents['%1']).toMatchObject({ session: 'web', windowIndex: 0, windowName: 'code', paneIndex: 0, state: 'done', ts: 200, visible: true, focused: true, attached: true });
  expect(s.agents['%2']).toMatchObject({ paneIndex: 1, state: 'done', ts: 200, visible: true, focused: false });
});

// --- agents per pane: edges --------------------------------------------------

test('a pane blocking in a background window notifies even while the session is attached', () => {
  const before = sampleOf(status({ paneMarks: marks({ '%0': ['working', 'prompt', 90] }) }), 1).agents;
  const next = sampleOf(status(), 2);
  expect(agentEdges(before, next, onScreenPanes(status()))).toEqual([
    { kind: 'agent-blocked', pane: '%0', session: 'main', windowId: '@0', window: '1:api', cause: 'permission', agent: 'claude' },
  ]);
});

test('the same edge for a pane on screen is silent', () => {
  const before = sampleOf(status({ paneMarks: marks({ '%1': ['working', 'prompt', 190] }) }), 1).agents;
  const next = sampleOf(status({ paneMarks: marks({ '%1': ['blocked', 'permission', 200] }) }), 2);
  expect(next.agents['%1']).toMatchObject({ state: 'blocked', visible: true, attached: true });
  expect(agentEdges(before, next, onScreenPanes(status()))).toEqual([]);
  // The same edge with nobody attached does notify, so the line above is the suppression.
  const detached = (m) => { const s = status({ paneMarks: marks(m) }); s.sessions[0].attached = false; return s; };
  const b2 = sampleOf(detached({ '%1': ['working', 'prompt', 190] }), 1).agents;
  expect(agentEdges(b2, sampleOf(detached({ '%1': ['blocked', 'permission', 200] }), 2), new Set())).toEqual([
    { kind: 'agent-blocked', pane: '%1', session: 'main', windowId: '@1', window: '2:frontend', paneIndex: 1, cause: 'permission', agent: 'claude' },
  ]);
});

test('a finished turn off screen is agent-input and names the pane index when the window holds two agents', () => {
  const before = sampleOf(apiInFront({ paneMarks: marks({ '%2': ['working', 'prompt', 190] }) }), 1).agents;
  const next = sampleOf(apiInFront({ paneMarks: marks({ '%2': ['ready', 'stop', 200] }) }), 2);
  expect(next.agents['%2']).toMatchObject({ state: 'done', visible: false });
  expect(agentEdges(before, next, onScreenPanes(apiInFront()))).toEqual([
    { kind: 'agent-input', pane: '%2', session: 'main', windowId: '@1', window: '2:frontend', paneIndex: 2, agent: 'codex' },
  ]);
});

test('a window name that is empty is named `window`', () => {
  const st = (m) => { const s = status({ paneMarks: marks(m) }); s.sessions[0].windowList[0].name = ''; return s; };
  const before = sampleOf(st({ '%0': ['working', 'prompt', 90] }), 1).agents;
  expect(agentEdges(before, sampleOf(st({ '%0': ['ready', 'stop', 95] }), 2), new Set())[0].window).toBe('1:window');
});

test('a pane that had a state and left the listing is agent-done; one now at a shell on screen is not', () => {
  const before = sampleOf(status({ paneMarks: marks({ '%0': ['working', 'prompt', 90] }) }), 1).agents;
  // Gone from the listing.
  const gone = status({ paneMarks: marks({}) });
  gone.panes = gone.panes.filter((p) => p.pane !== '%0');
  expect(agentEdges(before, sampleOf(gone, 2), onScreenPanes(gone))).toEqual([
    { kind: 'agent-done', pane: '%0', session: 'main', windowId: '@0', window: '1:api', agent: 'claude' },
  ]);
  // Back at its shell in a background window: still an exit.
  const shell = status({ paneMarks: marks({}) });
  shell.panes = shell.panes.map((p) => (p.pane === '%0' ? { ...p, cmd: 'zsh' } : p));
  expect(agentEdges(before, sampleOf(shell, 2), onScreenPanes(shell)).map((e) => [e.kind, e.pane])).toEqual([['agent-done', '%0']]);
  // Back at its shell with the operator now looking at its window: silent.
  const looking = apiInFront({ paneMarks: marks({}) });
  looking.panes = looking.panes.map((p) => (p.pane === '%0' ? { ...p, cmd: 'zsh' } : p));
  expect(onScreenPanes(looking).has('%0')).toBe(true);
  expect(agentEdges(before, sampleOf(looking, 2), onScreenPanes(looking))).toEqual([]);
  // And one that was on screen when it last had a state is silent too.
  const seenBefore = sampleOf(status({ paneMarks: marks({ '%1': ['working', 'prompt', 90] }) }), 1).agents;
  const gone1 = status({ paneMarks: marks({}) });
  gone1.panes = gone1.panes.filter((p) => p.pane !== '%1');
  expect(agentEdges(seenBefore, sampleOf(gone1, 2), onScreenPanes(gone1))).toEqual([]);
});

test('a pane still running its agent with no marker is a gap, not an exit', () => {
  const before = sampleOf(status({ paneMarks: marks({ '%0': ['working', 'prompt', 90] }) }), 1).agents;
  const gap = status({ paneMarks: marks({}) });
  const next = sampleOf(gap, 2);
  expect('state' in next.agents['%0']).toBe(false);
  expect(agentEdges(before, next, onScreenPanes(gap))).toEqual([]);
});

test('first appearance emits nothing', () => {
  expect(agentEdges(undefined, sampleOf(status(), 1), new Set())).toEqual([]);
});

// --- edges through classifyTransitions (the sweep's path) ---------------------

const A = (agents) => ({ up: true, agents });
// A pane entry: its own session `web` and window unless told otherwise.
const E = (state, extra = {}) => ({ session: 'web', windowId: '@0', windowIndex: 0, windowName: 'web', paneIndex: 0,
  agent: 'claude', visible: true, focused: true, attached: false, state, ts: 1, ...extra });
const ev = (kind, pane, extra = {}) => ({ kind, pane, session: 'web', windowId: '@0', window: '0:web', agent: 'claude', ...extra });
const TWO = { session: 'web-2', windowId: '@1', windowName: 'two' };
const evTwo = (kind, extra = {}) => ev(kind, '%2', { session: 'web-2', windowId: '@1', window: '0:two', ...extra });
const seeded = (agents) => ({ ...initThresholdState(), agents });

test('agent edges run per pane and carry the pane and its place', () => {
  let st = initThresholdState();
  let r = classifyTransitions(A({ '%1': E('working'), '%2': E('working', TWO) }), A({ '%1': E('working'), '%2': E('working', TWO) }), TH, st); st = r.state;
  r = classifyTransitions(A({}), A({ '%1': E('blocked', { cause: 'permission' }), '%2': E('done', TWO) }), TH, st);
  expect(r.events).toEqual([ev('agent-blocked', '%1', { cause: 'permission' }), evTwo('agent-input')]);
});

test('first appearance of a pane emits nothing, even when it appears blocked', () => {
  const r = classifyTransitions(A({}), A({ '%1': E('blocked', { cause: 'permission' }) }), TH, initThresholdState());
  expect(r.events).toEqual([]);
});

test('a failed probe does not replace the previous map, so the box coming back is not a first appearance', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ '%1': E('working') }), TH, st).state;
  st = classifyTransitions(A({ '%1': E('working') }), { up: false }, TH, st).state;   // no agents key
  const r = classifyTransitions({ up: false }, A({ '%1': E('done') }), TH, st);
  expect(r.events).toEqual([{ kind: 'up' }, ev('agent-input', '%1')]); // reachability edge first, as before
});

test('blocked → done without a working in between still fires agent-input', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ '%1': E('blocked') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ '%1': E('done') }), TH, st).events).toEqual([ev('agent-input', '%1')]);
});

test('on screen suppresses agent-blocked and agent-input but is not a seen mark (the state stays done)', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ '%1': E('working') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ '%1': E('done', { attached: true }) }), TH, st).events).toEqual([]);
  // Attached but in a background window is not on screen.
  expect(classifyTransitions(A({}), A({ '%1': E('done', { attached: true, visible: false, focused: false }) }), TH, st).events)
    .toEqual([ev('agent-input', '%1')]);
});

test('a marker gap with the agent pane still listed fires no agent-done; an exited agent does', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ '%1': E('done') }), TH, st).state;
  const { state: _s, ts: _t, ...gap } = E('done');
  expect(classifyTransitions(A({}), A({ '%1': gap }), TH, st).events).toEqual([]);
  expect(classifyTransitions(A({}), A({}), TH, st).events).toEqual([ev('agent-done', '%1')]);
  // Gone, but its pane is on screen now (at a shell the operator is looking at): silent.
  expect(classifyTransitions(A({}), A({}), TH, st, new Set(['%1'])).events).toEqual([]);
});

test('a persisting blocker emits once', () => {
  let st = initThresholdState();
  st = classifyTransitions(A({}), A({ '%1': E('working') }), TH, st).state;
  const r = classifyTransitions(A({}), A({ '%1': E('blocked', { cause: 'question' }) }), TH, st); st = r.state;
  expect(r.events).toHaveLength(1);
  expect(classifyTransitions(A({}), A({ '%1': E('blocked', { cause: 'question' }) }), TH, st).events).toEqual([]);
});

test('agent-input fires once on working to done off screen', () => {
  const r1 = classifyTransitions(A({}), A({ '%1': E('done') }), TH, seeded({ '%1': E('working') }));
  expect(r1.events).toContainEqual(ev('agent-input', '%1'));
  const r2 = classifyTransitions(A({}), A({ '%1': E('done') }), TH, r1.state);
  expect(r2.events).toEqual([]);
});

test('agent-done needs an up, running box: a stopped guest resets the map', () => {
  expect(classifyTransitions(A({}), { up: true, stopped: true, agents: {} }, TH, seeded({ '%1': E('working') })).events).toEqual([]);
  expect(classifyTransitions(A({}), A({}), TH, seeded({ '%1': E('working') })).events).toEqual([ev('agent-done', '%1')]);
});

const probeOut = (viewers, cmd, mark) => [
  `web:1:${viewers}:1000:${cmd}`,
  '__WIN__ web:0:@0:1:web',
  `__PANE__ web:@0:%1:0:1:0:${cmd}`,
  ...(mark ? [`__AGENT__ web:${mark}:%1`] : []),
].join('\n');

test('multi-viewer tmux session (#{session_attached} >= 2) suppresses agent-input and agent-done for a pane on screen', () => {
  const box = { id: 'b1', label: 'web-01', host: 'h1' };
  const run = (viewers) => {
    const h = createHealthHistory({});
    h.record({ b1: fromProbe(probeOut(viewers, 'claude', 'working:990:prompt')) }, [box]);
    h.record({ b1: fromProbe(probeOut(viewers, 'claude', 'ready:1005:stop')) }, [box]);
    h.record({ b1: fromProbe(probeOut(viewers, 'zsh')) }, [box]);
    return h.getEvents({}).events;
  };
  expect(run(2)).toEqual([]);
  // the same transitions with nobody attached DO fire, so the line above proves suppression
  expect(run(0).map((e) => e.kind).sort()).toEqual(['agent-done', 'agent-input']);
});

test('agent-done fires when the agent exits on an up box, and either end on screen silences it', () => {
  const run = (v0, v1) => {
    const was = fromProbe(probeOut(v0, 'claude', 'working:990:prompt'));
    const now = fromProbe(probeOut(v1, 'zsh'));
    return classifyTransitions(sampleOf(was, 5), sampleOf(now, 5), TH, seeded(sampleOf(was, 5).agents), onScreenPanes(now)).events;
  };
  expect(run(0, 0)).toEqual([ev('agent-done', '%1')]);
  expect(run(1, 0)).toEqual([]); // prev on screen
  expect(run(0, 1)).toEqual([]); // next on screen (pane listed, now zsh)
});

test('stopping then starting a Proxmox box fires no stale agent-done', () => {
  const ready = fromProbe(probeOut(0, 'claude', 'ready:990:stop'));
  const samples = [ready, { proxmoxState: 'stopped' }, { reachable: true, sessions: [] }].map((x) => sampleOf(x, 5));
  const st = classifyTransitions(null, samples[0], TH, initThresholdState()).state;
  let r = classifyTransitions(samples[0], samples[1], TH, st);
  expect(r.events.map((e) => e.kind)).not.toContain('agent-done');
  r = classifyTransitions(samples[1], samples[2], TH, r.state);
  expect(r.events.map((e) => e.kind)).not.toContain('agent-done');
});

test('a plain down -> up keeps the previous map, so an agent gone across a reboot fires agent-done', () => {
  const ready = sampleOf(fromProbe(probeOut(0, 'claude', 'ready:990:stop')), 5);
  const down = sampleOf({ reachable: false }, 5);
  const back = sampleOf({ reachable: true, sessions: [] }, 5);
  const st = classifyTransitions(null, ready, TH, initThresholdState()).state;
  const r = classifyTransitions(ready, down, TH, st);
  expect(classifyTransitions(down, back, TH, r.state).events.map((e) => e.kind)).toEqual(['up', 'agent-done']);
});

test('agent kinds never fire on the first sample (no prev)', () => {
  expect(classifyTransitions(null, A({ '%1': E('done') }), TH, initThresholdState()).events).toEqual([]);
});

// Only a hook marker produces 'working', so a single-poll working -> done edge
// is a real turn ending and fires at once.
test('a single-poll working sample followed by done fires agent-input immediately', () => {
  let st = classifyTransitions(A({}), A({ '%1': E('done') }), TH, initThresholdState()).state;
  st = classifyTransitions(A({}), A({ '%1': E('working') }), TH, st).state;
  expect(classifyTransitions(A({}), A({ '%1': E('done') }), TH, st).events).toEqual([ev('agent-input', '%1')]);
});

test('a long task fires once, not once per poll', () => {
  let st = classifyTransitions(A({}), A({ '%1': E('working') }), TH, initThresholdState()).state;
  let fired = 0;
  for (let poll = 0; poll < 10; poll += 1) {
    const r = classifyTransitions(A({}), A({ '%1': E('working') }), TH, st);
    st = r.state;
    fired += r.events.length;
  }
  fired += classifyTransitions(A({}), A({ '%1': E('done') }), TH, st).events.length;
  expect(fired).toBe(1);
});

test('first appearance as done emits nothing, but a previous working entry makes done fire', () => {
  expect(classifyTransitions(A({}), A({ '%1': E('done') }), TH, initThresholdState()).events).toEqual([]);
  expect(classifyTransitions(A({}), A({ '%1': E('done') }), TH, seeded({ '%1': E('working') })).events)
    .toEqual([ev('agent-input', '%1')]);
});

test('deriveAgentState: start is idle, stop is done until seen, blocked and working pass through', () => {
  expect(deriveAgentState({ state: 'working', cause: 'prompt', ts: 10 })).toBe('working');
  expect(deriveAgentState({ state: 'blocked', cause: 'permission', ts: 10 })).toBe('blocked');
  expect(deriveAgentState({ state: 'ready', cause: 'start', ts: 10 })).toBe('idle');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 })).toBe('done');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 }, 9)).toBe('done');
  expect(deriveAgentState({ state: 'ready', cause: 'stop', ts: 10 }, 10)).toBe('idle');
});

// --- the history: record, recordAgents, markSeen -------------------------------

// One pane per row, each session with one window named after it.
function paneStatus(rows, extra = {}) {
  const sessions = [];
  const panes = [];
  const paneMarks = Object.create(null);
  for (const { session = 'web', pane = '%1', cmd = 'claude', attached = false, mark: m } of rows) {
    if (!sessions.some((s) => s.name === session)) {
      sessions.push({ name: session, windows: 1, attached, activity: 0, paneCmd: cmd, windowList: [{ id: '@0', index: 0, name: session, active: true }] });
    }
    panes.push({ session, windowId: '@0', pane, index: 0, active: true, zoomed: false, cmd });
    if (m) paneMarks[pane] = { session, ...m };
  }
  return { reachable: true, tmux: true, sessions, panes, ...(Object.keys(paneMarks).length ? { paneMarks } : {}), ...extra };
}
const mark = (state, cause, ts) => ({ state, cause, ts });
// The common case: pane %1, alone in session `web`.
const one = (m, opts = {}) => paneStatus([{ mark: m, ...opts }]);
function memSeenStore(init = {}) { let data = init; return { load: () => data, save: (m) => { data = m; }, whenIdle: async () => {}, get data() { return data; } }; }

test('a seen pane that finishes a new turn is done again, and the event carries the pane and its place', () => {
  const store = memSeenStore({ b1: { '%1': 100 } });
  const seen = [];
  const h = createHealthHistory({ seenStore: store, onEvent: (e) => seen.push(e), now: () => 7 });
  const box = { id: 'b1', label: 'web-01', host: 'h' };
  h.record({ b1: one(mark('working', 'prompt', 150)) }, [box]);
  h.record({ b1: one(mark('ready', 'stop', 200)) }, [box]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');
  expect(seen).toHaveLength(1);
  expect(seen[0]).toEqual({ boxId: 'b1', label: 'web-01', host: 'h', t: 7, kind: 'agent-input', seq: 1,
    session: 'web', pane: '%1', windowId: '@0', window: '0:web', agent: 'claude' });
});

test('record copies paneIndex onto the event when the window holds two agents', () => {
  const h = createHealthHistory();
  const box = { id: 'b1', host: 'h' };
  const st = (m) => apiInFront({ paneMarks: marks(m) });
  h.record({ b1: st({ '%2': ['working', 'prompt', 150] }) }, [box]);
  h.record({ b1: st({ '%2': ['blocked', 'question', 160] }) }, [box]);
  expect(h.getEvents().events[0]).toMatchObject({ kind: 'agent-blocked', pane: '%2', session: 'main', windowId: '@1', window: '2:frontend', paneIndex: 2, cause: 'question', agent: 'codex' });
});

test('a persisted agent-blocked event carries pane, session and cause; whenIdle resolves without a store', async () => {
  const h = createHealthHistory();
  const box = { id: 'b1', host: 'h' };
  h.record({ b1: one(mark('working', 'prompt', 150)) }, [box]);
  h.record({ b1: one(mark('blocked', 'permission', 160)) }, [box]);
  const e = h.getEvents().events.find((x) => x.kind === 'agent-blocked');
  expect(e).toMatchObject({ boxId: 'b1', pane: '%1', session: 'web', cause: 'permission' });
  expect('paneIndex' in e).toBe(false);
  await expect(h.whenIdle()).resolves.toBeUndefined();
});

test('a status listing sessions but not panes neither emits nor replaces the baseline', () => {
  const h = createHealthHistory();
  const box = { id: 'b1', host: 'h' };
  h.record({ b1: one(mark('working', 'prompt', 100)) }, [box]);
  const noPanes = one(mark('working', 'prompt', 100));
  delete noPanes.panes;
  h.record({ b1: noPanes }, [box]);
  expect(h.getEvents().events).toEqual([]);
  expect('agents' in h.getSeries('b1').at(-1)).toBe(false);
  h.record({ b1: paneStatus([{ pane: '%9', cmd: 'zsh' }]) }, [box]);      // %1 is gone now
  expect(h.getEvents().events.map((e) => [e.kind, e.pane])).toEqual([['agent-done', '%1']]);
});

test('a watermark loaded from seenStore.load() yields idle on the FIRST record of a ready/stop marker', () => {
  const h = createHealthHistory({ seenStore: memSeenStore({ b1: { '%1': 100 } }) });
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [{ id: 'b1', host: 'h' }]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('idle');
});

test('a removed box drops its seen entry', () => {
  const store = memSeenStore({ b1: { '%1': 100 }, b2: { '%1': 5 } });
  const h = createHealthHistory({ seenStore: store });
  h.record({ b2: one(null) }, [{ id: 'b2', host: 'h' }]);   // b2 still lists %1
  expect(store.data).toEqual({ b2: { '%1': 5 } });
});

// A box listed in `boxes` with no status this pass (the Host Shell sampler
// losing its race) is skipped, not pruned: its seen entry and series survive.
test('a listed box with no status this pass keeps its seen entry and series', () => {
  const store = memSeenStore({ b1: { '%1': 100 } });
  const h = createHealthHistory({ seenStore: store });
  const box = { id: 'b1', host: 'h' };
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [box]);
  h.record({}, [box]);
  expect(store.data).toEqual({ b1: { '%1': 100 } });
  expect(h.getSeries('b1')).toHaveLength(1);
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [box]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('idle');
});

test('markSeen turns done into idle and persists; a ts ahead of the marker is refused', () => {
  const store = memSeenStore();
  const h = createHealthHistory({ seenStore: store, now: () => 1 });
  const box = { id: 'b1', host: 'h' };
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [box]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');
  expect(h.markSeen('b1', '%1', 101)).toBe(false);
  expect(h.markSeen('b1', '%7', 100)).toBe(false);
  expect(h.markSeen('b1', '%1', 100)).toBe(true);
  expect(store.data).toEqual({ b1: { '%1': 100 } });
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [box]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('idle');
});

test('agentKindOf lives in agentKind.js and healthHistory re-exports the same function', () => {
  expect(agentKindOf).toBe(agentKindOfModule);
});

test('agentKindOf: claude and opencode panes are agents, shells and node are not', () => {
  expect(agentKindOf('claude')).toBe('claude'); expect(agentKindOf('claude-code')).toBe('claude');
  expect(agentKindOf('opencode')).toBe('opencode'); expect(agentKindOf('opencode-x')).toBe('opencode');
  expect(agentKindOf('node')).toBeNull(); expect(agentKindOf('zsh')).toBeNull(); expect(agentKindOf('')).toBeNull();
});

test('sampleOf: an opencode pane with a marker carries state and agent: opencode', () => {
  const s = sampleOf(one(mark('blocked', 'permission', 990), { cmd: 'opencode' }), 5);
  expect(s.agents['%1']).toEqual({ session: 'web', windowId: '@0', windowIndex: 0, windowName: 'web', paneIndex: 0,
    agent: 'opencode', state: 'blocked', cause: 'permission', ts: 990, visible: true, focused: true, attached: false });
});

test('agent events carry the agent kind, including agent-done after the pane is gone', () => {
  const a = sampleOf(one(mark('working', 'prompt', 1), { cmd: 'opencode' }), 5);
  const b = sampleOf(one(mark('blocked', 'permission', 2), { cmd: 'opencode' }), 5);
  let st = initThresholdState();
  st = classifyTransitions(null, a, TH, st).state;
  const r = classifyTransitions(a, b, TH, st); st = r.state;
  expect(r.events).toEqual([ev('agent-blocked', '%1', { cause: 'permission', agent: 'opencode' })]);
  const gone = { up: true, agents: {} };
  expect(classifyTransitions(b, gone, TH, st).events).toEqual([ev('agent-done', '%1', { agent: 'opencode' })]);
});

test('record() keeps the agent kind on emitted and persisted agent events, and none on others', () => {
  const run = (cmd) => {
    const emitted = [];
    const h = createHealthHistory({ onEvent: (e) => emitted.push(e) });
    const box = { id: 'b1', host: 'h' };
    h.record({ b1: one(mark('working', 'prompt', 150), { cmd }) }, [box]);
    h.record({ b1: one(mark('blocked', 'permission', 160), { cmd }) }, [box]);
    h.record({ b1: { reachable: false, error: 'x' } }, [box]);
    const persisted = h.getEvents().events.find((e) => e.kind === 'agent-blocked');
    return { emitted: emitted.find((e) => e.kind === 'agent-blocked'), persisted, down: emitted.find((e) => e.kind === 'down') };
  };
  for (const kind of ['opencode', 'claude']) {
    const r = run(kind);
    for (const e of [r.emitted, r.persisted]) expect(e).toMatchObject({ agent: kind, pane: '%1', session: 'web', cause: 'permission' });
  }
  const down = run('claude').down;
  for (const k of ['agent', 'pane', 'session', 'windowId', 'window']) expect(k in down).toBe(false);
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

const RT_BOX = { id: 'b1', label: 'web-01', host: 'h1' };
function rtHistory(extra = {}) {
  let t = 1000;
  const saved = [];
  const pushed = [];
  const h = createHealthHistory({ now: () => t, save: (e) => saved.push(e.length), onEvent: (e) => pushed.push(e), ...extra });
  return { h, saved, pushed, tick: (ms) => { t += ms; } };
}

test('recordAgents rewrites the latest sample in place and emits the edge at once', () => {
  const { h, saved, pushed, tick } = rtHistory();
  h.record({ b1: { ...one(mark('working', 'prompt', 100)), metrics: { memTotalKb: 100, memAvailKb: 40 } } }, [RT_BOX]);
  tick(3000);
  expect(h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 101)))).toBe(true);
  const ring = h.getSeries('b1');
  // Not a new sample: the series keeps the sweep's cadence, time and metrics.
  expect(ring).toHaveLength(1);
  expect(ring[0].t).toBe(1000);
  expect(ring[0].memPct).toBe(60);
  expect(ring[0].agents['%1']).toMatchObject({ state: 'blocked', cause: 'permission', ts: 101, agent: 'claude' });
  expect('agent' in ring[0]).toBe(false);
  const { events } = h.getEvents();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'agent-blocked', boxId: 'b1', label: 'web-01', pane: '%1', session: 'web', windowId: '@0', window: '0:web', cause: 'permission', agent: 'claude', t: 4000 });
  expect(pushed).toHaveLength(1);
  expect(saved).toEqual([1]);
});

test('recordAgents notifies for a pane in a background window of an attached session', () => {
  const { h } = rtHistory();
  h.record({ b1: status({ paneMarks: marks({ '%0': ['working', 'prompt', 90] }) }) }, [RT_BOX]);
  expect(h.recordAgents(RT_BOX, status())).toBe(true);
  expect(h.getEvents().events.map((e) => [e.kind, e.pane, e.window])).toEqual([['agent-blocked', '%0', '1:api']]);
});

test('the sweep after a recordAgents sees the same state and does not notify twice', () => {
  const { h, tick } = rtHistory();
  h.record({ b1: one(mark('working', 'prompt', 100)) }, [RT_BOX]);
  h.recordAgents(RT_BOX, one(mark('ready', 'stop', 105)));
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-input']);
  tick(30000);
  h.record({ b1: one(mark('ready', 'stop', 105)) }, [RT_BOX]);
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-input']);
  expect(h.getSeries('b1')).toHaveLength(2);
});

test('recordAgents needs a sweep baseline and an up, running box', () => {
  const { h } = rtHistory();
  // Never swept: there is no sample to rewrite and no previous state to edge from.
  expect(h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 1)))).toBe(false);
  expect(h.getSeries('b1')).toEqual([]);
  h.record({ b1: { reachable: false } }, [RT_BOX]);
  expect(h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 1)))).toBe(false);
  h.record({ b1: { reachable: false, proxmoxState: 'stopped' } }, [RT_BOX]);
  expect(h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 1)))).toBe(false);
  expect(h.getEvents().events.filter((e) => e.kind.startsWith('agent'))).toEqual([]);
});

test('recordAgents ignores a status whose session or pane listing is unknown', () => {
  const { h } = rtHistory();
  h.record({ b1: one(mark('working', 'prompt', 100)) }, [RT_BOX]);
  // No `sessions` key = tmux could not be listed. That is not "every session
  // ended", so nothing may change and no agent-done may fire.
  expect(h.recordAgents(RT_BOX, { reachable: true, paneMarks: marks({ '%1': ['ready', 'stop', 101, 'web'] }) })).toBe(false);
  // Sessions but no `panes`: the pane listing was capped or failed.
  const noPanes = one(mark('ready', 'stop', 101));
  delete noPanes.panes;
  expect(h.recordAgents(RT_BOX, noPanes)).toBe(false);
  expect(h.getSeries('b1')[0].agents['%1'].state).toBe('working');
  expect(h.getEvents().events).toEqual([]);
});

test('recordAgents keeps the suppression and first-appearance rules', () => {
  const { h } = rtHistory();
  h.record({ b1: one(mark('working', 'prompt', 100), { attached: true }) }, [RT_BOX]);
  h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 101), { attached: true }));
  expect(h.getEvents().events).toEqual([]); // the operator is looking at it
  // A pane that was not there at the last sample has no previous state.
  const both = (twoMark) => paneStatus([{ mark: mark('working', 'prompt', 102) }, { session: 'two', pane: '%2', mark: twoMark }]);
  h.recordAgents(RT_BOX, both(mark('blocked', 'question', 103)));
  expect(h.getEvents().events).toEqual([]);
  // ...but from then on it edges like any other.
  h.recordAgents(RT_BOX, both(mark('working', 'unblock', 104)));
  h.recordAgents(RT_BOX, both(mark('ready', 'stop', 105)));
  expect(h.getEvents().events.map((e) => [e.kind, e.pane, e.session])).toEqual([['agent-input', '%2', 'two']]);
});

test('recordAgents reports an agent that exited', () => {
  const { h } = rtHistory();
  h.record({ b1: one(mark('working', 'prompt', 100)) }, [RT_BOX]);
  expect(h.recordAgents(RT_BOX, paneStatus([{ cmd: 'zsh' }]))).toBe(true);
  expect(h.getEvents().events.map((e) => [e.kind, e.pane])).toEqual([['agent-done', '%1']]);
  expect(h.getSeries('b1')[0].agents).toEqual({});
});

test('recordAgents leaves the metric thresholds and every other box alone', () => {
  const { h, tick } = rtHistory();
  const hot = (m) => ({ ...one(m), metrics: { cpuPct: 99 } });
  const b2 = { id: 'b2', label: 'db-01', host: 'h2' };
  const cool = { reachable: true, tmux: true, sessions: [], metrics: { cpuPct: 5 } };
  h.record({ b1: { ...one(mark('working', 'prompt', 100)), metrics: { cpuPct: 5 } }, b2: cool }, [RT_BOX, b2]);
  tick(30000);
  h.record({ b1: hot(mark('working', 'prompt', 100)), b2: cool }, [RT_BOX, b2]); // first over-sample: no event yet
  // Three marker changes inside the interval. None is a CPU sample: the streak
  // must neither reach two (a false alarm) nor reset (a missed one).
  h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 101)));
  h.recordAgents(RT_BOX, one(mark('working', 'unblock', 102)));
  h.recordAgents(RT_BOX, one(mark('ready', 'stop', 103)));
  expect(h.getEvents().events.filter((e) => e.kind === 'threshold')).toEqual([]);
  expect(h.getSeries('b1').at(-1).cpuPct).toBe(99);
  expect(h.getSeries('b2')).toHaveLength(2); // a single-box update prunes nobody
  tick(30000);
  h.record({ b1: hot(mark('ready', 'stop', 103)), b2: cool }, [RT_BOX, b2]);
  expect(h.getEvents().events.filter((e) => e.kind === 'threshold')).toHaveLength(1);
});

test('recordAgents honours the seen watermark', () => {
  const h = createHealthHistory({ seenStore: memSeenStore({ b1: { '%1': 100 } }), now: () => 1 });
  h.record({ b1: one(mark('working', 'prompt', 90)) }, [RT_BOX]);
  h.recordAgents(RT_BOX, one(mark('ready', 'stop', 100)));
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('idle');
});

test('markSeen turns done into idle immediately, for every client reading the series', () => {
  const store = memSeenStore();
  const { h } = rtHistory({ seenStore: store });
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [RT_BOX]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');
  expect(h.markSeen('b1', '%1', 100)).toBe(true);
  const last = h.getSeries('b1').at(-1);
  expect(last.agents['%1'].state).toBe('idle');
  expect(Object.getPrototypeOf(last.agents)).toBe(null);
  expect(h.getSeries('b1')).toHaveLength(1);
  // The acknowledged turn is the baseline now: a later prompt still notifies.
  h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 110)));
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-blocked']);
});

test('markSeen below the marker ts leaves done alone', () => {
  const { h } = rtHistory({ seenStore: memSeenStore() });
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [RT_BOX]);
  expect(h.markSeen('b1', '%1', 90)).toBe(true); // an older turn's ack, accepted and inert
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');
});

// --- onChange: "this box's agents look different now" (the /live nudge seam) ---

test('onChange names a box whenever its agent map changes, from the sweep or the real-time path', () => {
  const { h } = rtHistory();
  const changed = [];
  const off = h.onChange((id) => changed.push(id));
  const b2 = { id: 'b2', label: 'db-01', host: 'h2' };
  const plain = { reachable: true, tmux: true, sessions: [] };
  h.record({ b1: one(mark('working', 'prompt', 100)), b2: plain }, [RT_BOX, b2]);
  expect(changed.sort()).toEqual(['b1', 'b2']);          // first sight of each
  changed.length = 0;
  h.record({ b1: one(mark('working', 'prompt', 100)), b2: plain }, [RT_BOX, b2]);
  expect(changed).toEqual([]);                           // nothing moved
  // A change that raises no event (-> working) still has to reach the tabs.
  h.record({ b1: one(mark('ready', 'stop', 101)), b2: plain }, [RT_BOX, b2]);
  h.recordAgents(RT_BOX, one(mark('working', 'prompt', 102)));
  expect(changed).toEqual(['b1', 'b1']);
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-input']);
  changed.length = 0;
  h.recordAgents(RT_BOX, one(mark('working', 'prompt', 102)));
  expect(changed).toEqual([]);                           // same again: no nudge
  // A viewer attaching changes what the board shows too.
  h.recordAgents(RT_BOX, one(mark('working', 'prompt', 102), { attached: true }));
  expect(changed).toEqual(['b1']);
  off();
  h.recordAgents(RT_BOX, one(mark('ready', 'stop', 103)));
  expect(changed).toEqual(['b1']);
});

test('a throwing onChange listener never breaks a record', () => {
  const { h } = rtHistory();
  h.onChange(() => { throw new Error('boom'); });
  expect(() => h.record({ b1: one(mark('working', 'prompt', 100)) }, [RT_BOX])).not.toThrow();
  expect(h.recordAgents(RT_BOX, one(mark('ready', 'stop', 101)))).toBe(true);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');
});

test('recordAgents landing in an exiting agent\'s marker gap does not lose the exit', () => {
  // Claude's SessionEnd hook removes the marker while `claude` is still the
  // pane's foreground command, and the marker removal is exactly what triggers
  // the real-time probe — so it lands in that gap every time. The pane is
  // listed with no state there. If that wiped the edge baseline, the pane
  // flipping to the shell a moment later (no marker change, so only the sweep
  // sees it) would have nothing to compare against and never report the exit.
  const { h, tick } = rtHistory();
  h.record({ b1: one(mark('working', 'prompt', 100)) }, [RT_BOX]);
  expect(h.recordAgents(RT_BOX, one(null))).toBe(true);
  // What is shown is the truth: an agent pane with no state.
  expect(h.getSeries('b1').at(-1).agents['%1']).toEqual({ session: 'web', windowId: '@0', windowIndex: 0, windowName: 'web', paneIndex: 0,
    agent: 'claude', visible: true, focused: true, attached: false });
  expect(h.getEvents().events).toEqual([]);
  tick(30000);
  h.record({ b1: paneStatus([{ cmd: 'zsh' }]) }, [RT_BOX]);
  expect(h.getEvents().events.map((e) => [e.kind, e.pane, e.session, e.agent])).toEqual([['agent-done', '%1', 'web', 'claude']]);
});

test('a marker gap bridged by recordAgents still edges correctly when the agent carries on', () => {
  const { h } = rtHistory();
  h.record({ b1: one(mark('working', 'prompt', 100)) }, [RT_BOX]);
  h.recordAgents(RT_BOX, one(null));                 // restarting in place
  h.recordAgents(RT_BOX, one(null));                 // still in the gap: the bridge holds
  h.recordAgents(RT_BOX, one(mark('ready', 'start', 101)));
  expect(h.getEvents().events).toEqual([]);          // a fresh start is idle: nothing to announce
  h.recordAgents(RT_BOX, one(mark('blocked', 'permission', 102)));
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-blocked']);
  // A pane that never had a state gains none from the bridge.
  const pair = (cmd) => paneStatus([{ mark: mark('blocked', 'permission', 102) }, { session: 'new', pane: '%2', cmd }]);
  h.recordAgents(RT_BOX, pair('claude'));
  h.recordAgents(RT_BOX, pair('zsh'));
  expect(h.getEvents().events.map((e) => e.kind)).toEqual(['agent-blocked']);
});

// --- seen, per pane ----------------------------------------------------------

// Two claude panes in one session, spoken for by one session-wide marker: a
// box whose setup has not been rerun.
const twoPanesOneMarker = (ts = 200) => fromProbe([
  'web:1:0:1000:claude',
  '__WIN__ web:0:@0:1:web',
  '__PANE__ web:@0:%1:0:1:0:claude',
  '__PANE__ web:@0:%2:1:0:0:claude',
  `__AGENT__ web:ready:${ts}:stop`,
].join('\n'));

test('markSeen turns that pane idle and leaves its neighbour done', () => {
  const store = memSeenStore();
  const h = createHealthHistory({ seenStore: store });
  const box = { id: 'b1', host: 'h' };
  h.record({ b1: twoPanesOneMarker() }, [box]);
  expect(h.getSeries('b1').at(-1).agents['%2'].state).toBe('done');
  expect(h.markSeen('b1', '%1', 200)).toBe(true);
  const a = h.getSeries('b1').at(-1).agents;
  expect(a['%1'].state).toBe('idle');
  expect(a['%2'].state).toBe('done');
  expect(store.data).toEqual({ b1: { '%1': 200 } });
  // And it stays that way on the next sweep.
  h.record({ b1: twoPanesOneMarker() }, [box]);
  const b = h.getSeries('b1').at(-1).agents;
  expect([b['%1'].state, b['%2'].state]).toEqual(['idle', 'done']);
});

test('refuses a ts ahead of the marker and a pane with no marker', () => {
  const h = createHealthHistory({ seenStore: memSeenStore() });
  h.record({ b1: twoPanesOneMarker() }, [{ id: 'b1', host: 'h' }]);
  expect(h.markSeen('b1', '%1', 201)).toBe(false);
  expect(h.markSeen('b1', '%9', 200)).toBe(false);
  expect(h.markSeen('b9', '%1', 200)).toBe(false);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');
});

test('drops watermark keys that are not pane ids on load', () => {
  // A file from before watermarks were per pane, keyed by session name.
  const store = memSeenStore({ b1: { main: 999999, '%1': 150, '%2': 'x', '%3': null }, b2: { '%4': 9 }, b3: 'junk' });
  const h = createHealthHistory({ seenStore: store });
  h.record({ b1: one(mark('ready', 'stop', 200)) }, [{ id: 'b1', host: 'h' }]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');   // 150 < 200
  // Recording only b1 prunes b2, which persists what is left of b1.
  expect(store.data).toEqual({ b1: { '%1': 150 } });
});

test('a reused pane id with an old watermark still reads done', () => {
  // The box's tmux server restarted and handed out %1 again: the old
  // watermark is compared with the new agent's own, newer, marker ts.
  const h = createHealthHistory({ seenStore: memSeenStore({ b1: { '%1': 500 } }) });
  h.record({ b1: one(mark('ready', 'stop', 900)) }, [{ id: 'b1', host: 'h' }]);
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('done');
});

test('prunes watermarks of panes no longer listed', () => {
  const store = memSeenStore({ b1: { '%1': 100, '%2': 50 } });
  const h = createHealthHistory({ seenStore: store });
  const box = { id: 'b1', host: 'h' };
  h.record({ b1: paneStatus([{ mark: mark('ready', 'stop', 100) }, { pane: '%2', session: 'two', mark: mark('ready', 'stop', 50) }]) }, [box]);
  expect(store.data).toEqual({ b1: { '%1': 100, '%2': 50 } });
  h.record({ b1: one(mark('ready', 'stop', 100)) }, [box]);             // %2 left the listing
  expect(store.data).toEqual({ b1: { '%1': 100 } });
});

test('seen survives a failed probe, a missing pane listing and a pane back at its shell, and goes with an empty tmux', () => {
  const store = memSeenStore({ b1: { '%1': 100 } });
  const h = createHealthHistory({ seenStore: store });
  const box = { id: 'b1', host: 'h' };
  h.record({ b1: { reachable: false } }, [box]);
  expect(store.data).toEqual({ b1: { '%1': 100 } });
  const noPanes = one(null);
  delete noPanes.panes;
  h.record({ b1: noPanes }, [box]);
  expect(store.data).toEqual({ b1: { '%1': 100 } });
  h.record({ b1: paneStatus([{ cmd: 'zsh' }]) }, [box]);                // still listed, no agent
  expect(store.data).toEqual({ b1: { '%1': 100 } });
  h.record({ b1: { reachable: true, tmux: true, sessions: [], panes: [] } }, [box]);
  expect(store.data).toEqual({ b1: {} });
});

test('recordAgents prunes the watermark of a pane that is gone', () => {
  const store = memSeenStore({ b1: { '%1': 100, '%2': 50 } });
  const h = createHealthHistory({ seenStore: store, now: () => 1 });
  const both = paneStatus([{ mark: mark('ready', 'stop', 100) }, { pane: '%2', session: 'two', mark: mark('ready', 'stop', 50) }]);
  h.record({ b1: both }, [RT_BOX]);
  h.recordAgents(RT_BOX, one(mark('ready', 'stop', 100)));
  expect(store.data).toEqual({ b1: { '%1': 100 } });
  // A light probe without a pane listing prunes nothing.
  const noPanes = one(mark('ready', 'stop', 100));
  delete noPanes.panes;
  h.recordAgents(RT_BOX, noPanes);
  expect(store.data).toEqual({ b1: { '%1': 100 } });
  expect(h.getSeries('b1').at(-1).agents['%1'].state).toBe('idle');
});
