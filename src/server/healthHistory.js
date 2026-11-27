import { SESSION_NAME_RE, PANE_ID_RE } from './sshCommand.js';
import { agentKindOf } from './agentKind.js';

// Defined in agentKind.js; re-exported because other modules import it from here.
export { agentKindOf };

// Mirrors src/web/statusDot.ts `cpuLoadPct`: normalize load average by core count
// to a percent, only usable when both are present. Kept in sync by hand (server
// is .js, that helper is .ts) — the display and the sample must read the same.
function cpuLoadPct(m) {
  if (!m || m.load1 == null || !m.cpus) return undefined;
  return Math.round((m.load1 / m.cpus) * 100);
}

export const AGENT_STATES = ['working', 'blocked', 'done', 'idle'];

// Marker -> displayed state. `seenTs` is the operator's seen watermark for the
// pane (undefined = never seen).
export function deriveAgentState(mark, seenTs) {
  if (mark.state === 'working') return 'working';
  if (mark.state === 'blocked') return 'blocked';
  if (mark.cause === 'start') return 'idle';
  if (seenTs != null && mark.ts <= seenTs) return 'idle';
  return 'done';
}

// Where each listed pane is, and whether it is on screen, from the status's
// own rows: one placement per pane id. A pane joins its session row by name
// and its window row through (session, window id); a pane whose session or
// window row is missing (the listings are separate tmux calls, and the window
// listing has its own row cap) has no placement, since nothing about it can be
// shown or judged. A session whose name does not pass SESSION_NAME_RE is left
// out too: every downstream route validates names and would reject it, so it
// must not become something anyone acts on.
//
//   visible  its window is the session's current one, and the window is not
//            zoomed or this is the window's active pane
//   focused  its window is current and it is the window's active pane
//   attached its session has a tmux client attached
//
// Grouped sessions (`new-session -t`) list one pane once per session of the
// group. It still gets one placement: under the session its marker names when
// that session lists it, else under the first session listing it, and every
// flag describes that one session. Watching the pane through another session
// of the group therefore neither acknowledges nor silences it, which errs
// toward an extra notification, never a missed one.
function placePanes(status) {
  const s = status || {};
  const placed = new Map();
  if (!Array.isArray(s.sessions) || !Array.isArray(s.panes)) return placed;
  // Maps, not objects: session names are box-controlled (`__proto__` is a
  // valid one).
  const sessions = new Map();
  for (const sess of s.sessions) if (sess && SESSION_NAME_RE.test(String(sess.name))) sessions.set(sess.name, sess);
  const marks = s.paneMarks && typeof s.paneMarks === 'object' ? s.paneMarks : null;
  for (const row of s.panes) {
    if (!row) continue;
    const sess = sessions.get(row.session);
    const win = sess && Array.isArray(sess.windowList) ? sess.windowList.find((w) => w && w.id === row.windowId) : undefined;
    if (!win) continue;
    const mark = marks && Object.hasOwn(marks, row.pane) ? marks[row.pane] : undefined;
    if (placed.has(row.pane) && !(mark && mark.session === row.session)) continue;
    const front = !!win.active;
    placed.set(row.pane, {
      row, win, mark,
      visible: front && (!row.zoomed || !!row.active),
      focused: front && !!row.active,
      attached: !!sess.attached,
    });
  }
  return placed;
}

// What the agent edges need from a status besides its sample, from one
// placement:
//   onScreen  every listed pane, agent or not, visible in an attached session
//             (the agent-done edge asks it about a pane that has just stopped
//             running an agent, and so has no entry any more)
//   unplaced  every listed pane running an agent that has no placement (its
//             window or session row is missing: the window listing hit its row
//             cap, which has no completeness flag, or the window appeared
//             between the two tmux calls). It has no entry, since it cannot be
//             named or jumped to, but it has not exited either: the edges keep
//             its baseline entry and raise no agent-done for it.
// An absent pane listing gives two empty sets.
function paneSets(status) {
  const placed = placePanes(status);
  const onScreen = new Set();
  const unplaced = new Set();
  for (const [pane, p] of placed) if (p.visible && p.attached) onScreen.add(pane);
  const rows = status && Array.isArray(status.panes) ? status.panes : [];
  for (const row of rows) if (row && !placed.has(row.pane) && agentKindOf(row.cmd) !== null) unplaced.add(row.pane);
  return { onScreen, unplaced };
}

// The panes the operator can see right now: visible in an attached session.
export function onScreenPanes(status) {
  return paneSets(status).onScreen;
}

// The edge baseline that follows `agents`: the new map plus, for each pane in
// `unplaced` (see paneSets), its entry from the previous baseline `before`,
// unchanged. A real transition is then still seen once the pane can be placed
// again, and its exit once it truly leaves. An entry is carried only while the
// listing still shows its pane running an agent, so the baseline cannot grow.
function carryUnplaced(agents, before, unplaced) {
  let out = agents;
  if (!before) return out;
  for (const pane of unplaced) {
    if (!Object.hasOwn(before, pane)) continue;
    if (out === agents) out = Object.assign(Object.create(null), agents);
    out[pane] = before[pane];
  }
  return out;
}

// Project a status result (from the poll snapshot) into the compact numbers a
// sparkline needs. A missing source is OMITTED (never 0) so the sparkline renders
// a gap, not a false floor. `up` = reachable and not needs-login — EXCEPT a
// confirmed Proxmox `stopped` box, which is `up: true` (and carries `stopped:
// true`) even though SSH can't reach it: an intentionally-stopped container is
// not a failure, so classifyTransitions must not fire a false down/up pair
// around the moment it stops or starts back up.
export function sampleOf(status, at, opts = {}) {
  const s = status || {};
  const stopped = s.proxmoxState === 'stopped';
  const sample = { t: at, up: stopped || (!!s.reachable && !s.needsAuth) };
  if (stopped) sample.stopped = true;
  if (s.tmux != null) sample.tmux = !!s.tmux;
  if (s.needsAuth) sample.needsAuth = true;
  if (s.hostKeyChanged) sample.keyChanged = true;
  const m = s.metrics;
  if (m) {
    // Prefer true cgroup utilization; fall back to load only when there is no
    // cgroup counter at all; omit while a cgroup host is warming up (one sample).
    let cpu;
    if (m.cpuPct != null) cpu = m.cpuPct;
    else if (m.cpuUsageUsec == null) cpu = cpuLoadPct(m);
    if (cpu != null) sample.cpuPct = cpu;
    if (m.memTotalKb && m.memAvailKb != null) sample.memPct = Math.round((1 - m.memAvailKb / m.memTotalKb) * 100);
    const disk = m.diskPct != null
      ? m.diskPct
      : (m.diskTotalKb && m.diskUsedKb != null ? Math.round((m.diskUsedKb / m.diskTotalKb) * 100) : undefined);
    if (disk != null) sample.diskPct = disk;
  }
  // Agents, one entry per tmux PANE whose foreground command is an agent
  // (agentKindOf), keyed by pane id. `sample.agents` is set (possibly {}) only
  // when the probe listed sessions AND their panes — or listed no sessions,
  // which means no panes. Sessions without a pane listing (it failed, or hit
  // its row cap) give NO agents key: the listing cannot be trusted to be
  // complete, so a pane missing from it is not an exit, and the edges below
  // must neither run on it nor replace their baseline with it.
  //
  // The pane listing is the authority for which panes exist; a marker for a
  // pane it does not list builds nothing. The entry carries the pane's place
  // (session, window id/index/name, pane index) so every renderer can name it
  // from the sample alone, and the flags of placePanes above. "On screen" is
  // `visible && attached`.
  //
  // `state`/`cause`/`ts` appear only when a box-side writer (the Claude hook,
  // the OpenCode plugin, the OSC reporter) left a marker for the pane: pane
  // output timing is never consulted, so an agent pane with no marker carries
  // no state (the deliberate cue that the box needs a setup rerun). The
  // displayed state comes from deriveAgentState with the caller's seen
  // watermark (`seenOf(paneId)`): `ready/stop` is `done` until the operator
  // has looked at that turn's end, `ready/start` is `idle` (nothing finished,
  // so nothing to acknowledge). The watermark is compared against the marker's
  // own ts and never against a clock, so time passing can never re-arm `done`;
  // only a new marker (a later ts) can.
  const { seenOf } = opts;
  if (Array.isArray(s.sessions) && (Array.isArray(s.panes) || s.sessions.length === 0)) {
    // Null-prototype, like every map keyed by box output.
    const agents = Object.create(null);
    for (const [pane, p] of placePanes(s)) {
      const kind = agentKindOf(p.row.cmd);
      if (kind === null) continue;
      const entry = {
        session: p.row.session,
        windowId: p.row.windowId, windowIndex: p.win.index, windowName: p.win.name, paneIndex: p.row.index,
        agent: kind,
      };
      if (p.mark) {
        const seen = typeof seenOf === 'function' ? seenOf(pane) : undefined;
        entry.state = deriveAgentState(p.mark, seen);
        entry.cause = p.mark.cause;
        entry.ts = p.mark.ts;
      }
      entry.visible = p.visible;
      entry.focused = p.focused;
      entry.attached = p.attached;
      agents[pane] = entry;
    }
    sample.agents = agents;
  }
  return sample;
}

// The fields of a sample that describe agents and tmux, i.e. everything the
// light probe behind recordAgents can refresh. All else (reachability, metrics,
// time) belongs to the sweep.
const AGENT_SAMPLE_KEYS = ['tmux', 'agents'];

export function initThresholdState() {
  // cpuSeeded: cpu% is delta-derived on cgroup hosts, so the sample right after
  // a restart carries no cpuPct. Seeding defers to the first sample that
  // actually observes one — otherwise a persistently-hot box would look like a
  // fresh crossing and replay a threshold event on every restart.
  return { cpu: false, cpuStreak: 0, cpuSeeded: true, mem: false, disk: false, agents: undefined };
}

// Where an agent event happened, from the entry that describes it: the pane,
// its session and window, and `paneIndex` only when that window held more
// than one agent entry in `agents` (the map the entry came from). The window's
// name is `<index>:<name>`, `window` standing in for an empty name.
function placeOf(pane, entry, agents) {
  const out = {
    pane, session: entry.session, windowId: entry.windowId,
    window: `${entry.windowIndex}:${entry.windowName || 'window'}`,
  };
  let inWindow = 0;
  for (const e of Object.values(agents)) if (e.session === entry.session && e.windowId === entry.windowId) inWindow += 1;
  if (inWindow > 1) out.paneIndex = entry.paneIndex;
  return out;
}

// Pure agent edge detector, per pane over `sample.agents` (see sampleOf).
// `before` is the previous map, `next` the new sample (which must carry
// `agents`), `onScreen` the panes on screen now (onScreenPanes of the status
// `next` came from), `unplaced` the panes that status lists running an agent
// but could not place (paneSets). Shared by the sweep (classifyTransitions) and the
// real-time path (recordAgents), so a marker change reads the same whichever
// one sees it. A pane with no previous entry (first appearance, restart)
// emits nothing.
//   agent-blocked: working|done|idle -> blocked (carries `cause`)
//   agent-input:   working|blocked   -> done
//   agent-done:    had a state, now absent from the map (gone, or no longer
//                  running an agent)
// Hook state is the sole source (a single-poll edge is a real transition; the
// box's own background-work gate in claudeAgentHooks.js keeps `Stop` pauses
// awaiting background work from reading as done, so there is no settle window
// here). blocked/input are suppressed while the pane is ON SCREEN (visible in
// an attached session) — watching it is its own notification — and only then:
// an agent blocking in a background window notifies even while the operator is
// attached and looking at another one. agent-done checks BOTH ends, since the
// operator may switch to it in the final poll interval; the `now` end comes
// from `onScreen`, because a pane that stopped running an agent has no entry.
// agent-done also requires the pane to be ABSENT from the map: an entry with no
// state is a marker gap (the agent restarting in place), not an exit; it must
// not be `unplaced` either: a pane still listed running an agent has not
// exited, whatever rows are missing around it; and `!next.stopped` — a
// Proxmox-stopped box carries no sessions, so absence there is not an
// observation. Event fields describe the current entry, or the previous one
// for agent-done.
export function agentEdges(before, next, onScreen = new Set(), unplaced = new Set()) {
  const events = [];
  const prev = before || Object.create(null);
  for (const [pane, now] of Object.entries(next.agents)) {
    const was = Object.hasOwn(prev, pane) ? prev[pane].state : undefined;
    if (!was || (now.visible && now.attached)) continue;
    const agent = now.agent ? { agent: now.agent } : {};
    if (now.state === 'blocked' && (was === 'working' || was === 'done' || was === 'idle')) {
      events.push({ kind: 'agent-blocked', ...placeOf(pane, now, next.agents), cause: now.cause, ...agent });
    } else if (now.state === 'done' && (was === 'working' || was === 'blocked')) {
      events.push({ kind: 'agent-input', ...placeOf(pane, now, next.agents), ...agent });
    }
  }
  if (next.up && !next.stopped) {
    for (const [pane, was] of Object.entries(prev)) {
      if (!was.state || (was.visible && was.attached)) continue;
      if (Object.hasOwn(next.agents, pane) || onScreen.has(pane) || unplaced.has(pane)) continue;
      events.push({ kind: 'agent-done', ...placeOf(pane, was, prev), ...(was.agent ? { agent: was.agent } : {}) });
    }
  }
  return events;
}

// Pure edge detector. Reachability/auth edges compare prev↔next (stateless).
// Metric-threshold edges use `state` + hysteresis so a box that stays hot fires
// once; cpu additionally needs two consecutive over-samples (it is spiky). A
// nullish `prev` means this is the box's first sample: seed the threshold state
// to match current values but emit nothing (a restart must not replay
// down/over for boxes already in that state). `onScreen` is the set of panes
// on screen in the status `next` came from (onScreenPanes), and `unplaced` the
// agent panes it lists but could not place (paneSets), for agentEdges.
// Returns { events, state }.
export function classifyTransitions(prev, next, thresholds, state, onScreen = new Set(), unplaced = new Set()) {
  const st = { ...(state || initThresholdState()) };
  const events = [];
  const warn = { cpu: thresholds.cpu, mem: thresholds.mem, disk: thresholds.disk };
  const clear = thresholds.hysteresis;

  if (!prev) {
    st.mem = !!(next.up && next.memPct != null && next.memPct >= warn.mem);
    st.disk = !!(next.up && next.diskPct != null && next.diskPct >= warn.disk);
    st.cpu = !!(next.up && next.cpuPct != null && next.cpuPct >= warn.cpu);
    st.cpuStreak = st.cpu ? 2 : 0;
    st.cpuSeeded = !!(next.up && next.cpuPct != null);
    st.agents = next.agents;
    return { events, state: st };
  }

  // reachability / auth / host-key edges. keyChanged wins over needsAuth (they
  // never co-occur: key verification aborts before auth).
  if (prev.up && !next.up) {
    events.push(next.keyChanged ? { kind: 'key-changed' } : next.needsAuth ? { kind: 'needs-auth' } : { kind: 'down' });
  } else if (!prev.up && next.up) {
    events.push({ kind: 'up' });
  } else if (!prev.up && !next.up && !prev.keyChanged && next.keyChanged) {
    events.push({ kind: 'key-changed' });
  } else if (!prev.up && !next.up && !prev.needsAuth && next.needsAuth && !next.keyChanged) {
    events.push({ kind: 'needs-auth' });
  } else if (!prev.up && !next.up && (prev.needsAuth || prev.keyChanged) && !next.needsAuth && !next.keyChanged) {
    events.push({ kind: 'down' });
  }

  // Agent edges: see agentEdges above. `st.agents` is the PREVIOUS map and is
  // always the last one taken from a successful probe: a failed probe's sample
  // has no `agents` key, so it neither emits nor replaces it, and the box
  // coming back is compared against what it looked like before it went away
  // rather than read as a first appearance. A probe whose pane listing was
  // absent or capped has no `agents` key either, so a listing that cannot be
  // trusted to be complete never reads as every missing pane having exited.
  // An agent pane listed without its window row keeps its previous entry
  // (carryUnplaced).
  if (next.agents) {
    events.push(...agentEdges(st.agents, next, onScreen, unplaced));
    st.agents = carryUnplaced(next.agents, st.agents, unplaced);
  }
  // A confirmed-stopped guest is a positive observation that nothing runs: reset
  // the map so the first probe after start is a first appearance, not a stale
  // agent-done. (A plain down -> up keeps the map: a claude that vanished across
  // a reboot does fire.)
  if (next.stopped) st.agents = {};

  // mem / disk: immediate crossing with hysteresis clear
  for (const metric of ['mem', 'disk']) {
    const v = next[`${metric}Pct`];
    if (v == null || !next.up) continue;
    if (!st[metric] && v >= warn[metric]) { st[metric] = true; events.push({ kind: 'threshold', metric, value: v }); }
    else if (st[metric] && v < warn[metric] - clear) { st[metric] = false; events.push({ kind: 'threshold-clear', metric, value: v }); }
  }

  // cpu: require two consecutive over-samples before firing (spiky metric)
  const cpu = next.cpuPct;
  if (cpu == null || !next.up) {
    st.cpuStreak = 0;
  } else if (!st.cpuSeeded) {
    // First observed cpu value (the counter was still warming at seed): adopt
    // it as the baseline without firing — same rule as the seed sample.
    st.cpuSeeded = true;
    st.cpu = cpu >= warn.cpu;
    st.cpuStreak = st.cpu ? 2 : 0;
  } else if (cpu >= warn.cpu) {
    st.cpuStreak = Math.min(2, st.cpuStreak + 1);
    if (!st.cpu && st.cpuStreak >= 2) { st.cpu = true; events.push({ kind: 'threshold', metric: 'cpu', value: cpu }); }
  } else {
    st.cpuStreak = 0;
    if (st.cpu && cpu < warn.cpu - clear) { st.cpu = false; events.push({ kind: 'threshold-clear', metric: 'cpu', value: cpu }); }
  }

  return { events, state: st };
}

// Owns the rolling per-box sample series (in-memory ring buffers) and the
// edge-triggered events log (persisted via the injected load/save — see
// healthEventsStore.js). Fed by the status poller after each snapshot swap;
// read by GET /api/health/*. Browser notifications are delivered client-side
// (src/web/main.ts pollHealth reads GET /api/health/events and filters by
// Settings → Notifications) — onEvent below is the server-push seam;
// fcmPush.js subscribes to it when TMUXIFIER_FCM_CREDENTIALS is set, browser
// notifications still poll client-side regardless.
//
// It also owns the agent "seen" watermarks (boxId -> pane id -> ts, persisted
// through the optional seenStore): a pane whose latest turn ended at or before
// its watermark reads idle instead of done. markSeen() advances a watermark
// (never past the live marker's ts). On load only pane-id keys are kept: a
// file from before watermarks were per pane is keyed by session name, which
// does not say which pane, so those turns read `done` once more until looked
// at. A watermark is pruned only when a complete pane listing no longer lists
// its pane — a failed probe, a stopped guest, a capped or failed listing, or a
// pane back at its shell keeps it. A pane id reused after the box's tmux
// server restarted is harmless: the watermark is compared with the marker's
// own ts, and a new agent's is newer. Agent events persist the pane and its
// place (`pane`, `session`, `windowId`, `window`, `paneIndex` when its window
// held more than one agent) and their `cause`.
export function createHealthHistory({
  maxSamples = 120,
  maxEvents = 200,
  thresholds = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 },
  load = () => [],
  save = () => {},
  now = () => Date.now(),
  onEvent = null,
  seenStore = null,
} = {}) {
  const series = new Map();      // boxId -> Sample[]
  const lastSample = new Map();  // boxId -> Sample
  const threshState = new Map(); // boxId -> threshold state
  const loaded = load();
  const events = Array.isArray(loaded) ? loaded.slice(-maxEvents) : []; // oldest first
  let seq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  const seen = new Map();        // boxId -> Map<pane id, ts>
  const loadedSeen = seenStore ? seenStore.load() : null;
  if (loadedSeen && typeof loadedSeen === 'object') {
    for (const [bid, m] of Object.entries(loadedSeen)) {
      if (!m || typeof m !== 'object') continue;
      const inner = new Map();
      for (const [pane, ts] of Object.entries(m)) if (PANE_ID_RE.test(pane) && Number.isFinite(ts)) inner.set(pane, ts);
      seen.set(bid, inner);
    }
  }
  // Drop the watermarks of panes a complete listing no longer has. Returns
  // whether anything was dropped.
  function pruneSeen(boxId, status) {
    const m = seen.get(boxId);
    if (!m || !Array.isArray(status.panes)) return false;
    const listed = new Set(status.panes.map((p) => p && p.pane));
    let dropped = false;
    for (const pane of [...m.keys()]) if (!listed.has(pane)) { m.delete(pane); dropped = true; }
    return dropped;
  }
  function persistSeen() {
    if (!seenStore) return;
    const out = {};
    for (const [bid, m] of seen) out[bid] = Object.fromEntries(m);
    seenStore.save(out);
  }
  const listeners = new Set();
  if (typeof onEvent === 'function') listeners.add(onEvent);
  // "This box's agents look different now": fired from record() and
  // recordAgents() whenever a box's agent map changed, whether or not the
  // change raised an event (-> working, an attach, a first appearance raise
  // none). The /live nudge (liveHub.js) subscribes so an open tab refetches
  // that box. A listener error must never break a record.
  const changeListeners = new Set();
  const agentsKey = (sample) => (sample && sample.agents ? JSON.stringify(sample.agents) : '');
  function changed(boxId) {
    for (const fn of changeListeners) { try { fn(boxId); } catch { /* ignore */ } }
  }

  // Swap a box's latest sample for `next`, in the ring and as the edge
  // baseline's sample, without adding a point to the series.
  function replaceLast(boxId, next) {
    lastSample.set(boxId, next);
    const ring = series.get(boxId);
    if (ring && ring.length) ring[ring.length - 1] = next;
  }

  // Persistence happens once per record() pass, not here — a 30-box outage
  // would otherwise do 30 back-to-back synchronous full-file writes.
  function emit(e) {
    e.seq = ++seq;
    events.push(e);
    while (events.length > maxEvents) events.shift();
    // Server-push seam: fcmPush.js subscribes when TMUXIFIER_FCM_CREDENTIALS
    // is set; browser notifications still poll GET /api/health/events
    // client-side regardless. A listener error must never break the poll.
    for (const fn of listeners) { try { fn(e); } catch { /* ignore */ } }
  }

  // An edge's fields onto the event record, beside the box's.
  function eventOf(box, at, ev) {
    const out = { boxId: box.id, label: box.label || box.host, host: box.host, t: at, kind: ev.kind };
    for (const k of ['session', 'pane', 'windowId', 'window', 'paneIndex', 'cause', 'agent']) {
      if (ev[k] !== undefined) out[k] = ev[k];
    }
    return out;
  }
  const seenOf = (boxId) => (pane) => seen.get(boxId)?.get(pane);

  return {
    record(snapshot, boxes) {
      const at = now();
      const present = new Set();
      let emitted = 0;
      let seenChanged = false;
      for (const box of boxes) {
        present.add(box.id);
        const status = snapshot[box.id];
        if (!status) continue;
        const sample = sampleOf(status, at, { seenOf: seenOf(box.id) });
        const ring = series.get(box.id) || [];
        ring.push(sample);
        while (ring.length > maxSamples) ring.shift();
        series.set(box.id, ring);

        const prev = lastSample.get(box.id);
        const { onScreen, unplaced } = paneSets(status);
        const { events: evs, state } = classifyTransitions(prev, sample, thresholds, threshState.get(box.id), onScreen, unplaced);
        threshState.set(box.id, state);
        lastSample.set(box.id, sample);
        if (agentsKey(prev) !== agentsKey(sample)) changed(box.id);
        if (pruneSeen(box.id, status)) seenChanged = true;
        for (const ev of evs) {
          const out = eventOf(box, at, ev);
          if (ev.metric) { out.metric = ev.metric; out.value = ev.value; }
          // Cap the reason: it is raw ssh stderr, which can be huge — the log
          // is persisted and re-served whole on every events poll.
          if (ev.kind === 'down' && status.error) out.reason = String(status.error).slice(0, 300);
          emit(out);
          emitted += 1;
        }
      }
      if (emitted) save(events);
      for (const id of [...series.keys()]) {
        if (!present.has(id)) { series.delete(id); lastSample.delete(id); threshState.delete(id); }
      }
      for (const id of [...seen.keys()]) {
        if (!present.has(id)) { seen.delete(id); seenChanged = true; }
      }
      if (seenChanged) persistSeen();
    },
    // The real-time path: one box's agent state changed between two sweeps
    // (statusPoller.refreshAgents, driven by agentWatch.js). `status` is that
    // box's snapshot entry with fresh sessions and markers. This is NOT a
    // sample: the series keeps the sweep's cadence, so the box's latest sample
    // is rewritten in place — its time and metrics stay, only the agent fields
    // move — and only the agent edges run. The metric thresholds are left
    // alone on purpose: cpu needs two consecutive SWEEP samples, and a burst of
    // marker changes must neither supply the second nor reset the streak.
    // Nothing is pruned (record() prunes boxes absent from its list; this one
    // is given a single box). Returns false, changing nothing, without a sweep
    // baseline, for a box whose last sample was down or stopped, or when the
    // status carries no session listing or no complete pane listing.
    recordAgents(box, status) {
      const prev = lastSample.get(box.id);
      if (!prev || !prev.up || prev.stopped || !status) return false;
      const fresh = sampleOf(status, prev.t, { seenOf: seenOf(box.id) });
      if (!fresh.agents) return false;
      const next = { ...prev };
      for (const k of AGENT_SAMPLE_KEYS) {
        if (fresh[k] !== undefined) next[k] = fresh[k]; else delete next[k];
      }
      const st = threshState.get(box.id) || initThresholdState();
      const { onScreen, unplaced } = paneSets(status);
      const evs = agentEdges(st.agents, next, onScreen, unplaced);
      // The edge baseline, bridged across a marker gap. An agent pane with no
      // marker is a gap, not an exit (agentEdges says so too), and this path
      // lands in one systematically: an exiting agent removes its marker
      // while it is still the pane's foreground command, and that removal is
      // what triggered this very probe. Taking the gap as the baseline would
      // erase the session's state, and the exit itself — the pane becoming a
      // shell, no marker change, seen only by the next sweep — would then go
      // unreported. So a pane that had a state and now shows none keeps its
      // previous state in the BASELINE only; the sample shows the truth.
      // (Every entry runs an agent: a pane that stopped running one has no
      // entry, and is the exit, not a gap.) An agent pane listed without its
      // window row keeps its previous entry, as on the sweep (carryUnplaced).
      const before = st.agents || Object.create(null);
      const baseline = Object.create(null);
      for (const [pane, now] of Object.entries(next.agents)) {
        const was = Object.hasOwn(before, pane) ? before[pane] : undefined;
        baseline[pane] = !now.state && was && was.state
          ? { ...now, state: was.state, cause: was.cause, ts: was.ts }
          : now;
      }
      threshState.set(box.id, { ...st, agents: carryUnplaced(baseline, before, unplaced) });
      replaceLast(box.id, next);
      if (agentsKey(prev) !== agentsKey(next)) changed(box.id);
      if (pruneSeen(box.id, status)) persistSeen();
      const at = now();
      for (const ev of evs) emit(eventOf(box, at, ev));
      if (evs.length) save(events);
      return true;
    },
    // Acknowledge one pane's finished turn: the pane must have a marker ts in
    // the latest sample, a ts ahead of it is refused, and an older watermark
    // is never lowered.
    markSeen(boxId, pane, ts) {
      const last = lastSample.get(boxId);
      const agents = last?.agents;
      const cur = agents && Object.hasOwn(agents, pane) ? agents[pane] : undefined;
      if (!cur || !Number.isFinite(cur.ts) || !Number.isFinite(ts) || ts > cur.ts) return false;
      let m = seen.get(boxId);
      if (!m) { m = new Map(); seen.set(boxId, m); }
      const prior = m.get(pane);
      if (prior !== undefined && prior >= ts) return true;
      m.set(pane, ts);
      persistSeen();
      // Apply the acknowledgement to the latest sample now rather than at the
      // next sweep, so every client reading the series (the other tab, the
      // phone) sees `idle` as soon as it asks. The same rule sampleOf applies:
      // a finished turn at or below the watermark is idle. The edge baseline
      // moves with it — done -> idle emits nothing either way.
      if (cur.state === 'done' && cur.ts <= ts) {
        const nextAgents = Object.assign(Object.create(null), agents, { [pane]: { ...cur, state: 'idle' } });
        const next = { ...last, agents: nextAgents };
        // Only this pane moves in the baseline: another one may be bridged
        // across a marker gap there (see recordAgents) and must stay so.
        const st = threshState.get(boxId);
        if (st) {
          const base = Object.assign(Object.create(null), st.agents);
          if (Object.hasOwn(base, pane)) base[pane] = { ...base[pane], state: 'idle' };
          threshState.set(boxId, { ...st, agents: base });
        }
        replaceLast(boxId, next);
      }
      return true;
    },
    whenIdle() { return seenStore?.whenIdle?.() ?? Promise.resolve(); },
    getSeries(boxId) {
      if (boxId) return series.get(boxId) || [];
      const out = {};
      for (const [id, ring] of series) out[id] = ring;
      return out;
    },
    getEvents({ since = 0 } = {}) {
      const filtered = since ? events.filter((e) => e.seq > since) : events.slice();
      return { events: filtered.reverse(), latestSeq: seq };
    },
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    onChange(cb) { changeListeners.add(cb); return () => changeListeners.delete(cb); },
  };
}
