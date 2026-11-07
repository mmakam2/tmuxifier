import { SESSION_NAME_RE } from './sshCommand.js';

// Mirrors src/web/statusDot.ts `cpuLoadPct`: normalize load average by core count
// to a percent, only usable when both are present. Kept in sync by hand (server
// is .js, that helper is .ts) — the display and the sample must read the same.
function cpuLoadPct(m) {
  if (!m || m.load1 == null || !m.cpus) return undefined;
  return Math.round((m.load1 / m.cpus) * 100);
}

export const AGENT_STATES = ['working', 'blocked', 'done', 'idle'];

// Marker -> displayed state. `seenTs` is the operator's seen watermark for the
// session (undefined = never seen).
export function deriveAgentState(mark, seenTs) {
  if (mark.state === 'working') return 'working';
  if (mark.state === 'blocked') return 'blocked';
  if (mark.cause === 'start') return 'idle';
  if (seenTs != null && mark.ts <= seenTs) return 'idle';
  return 'done';
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
  // Per-session agents. When the probe listed sessions, `sample.agents` is set
  // (possibly {}), keyed by session name, one entry per LISTED session whose
  // name passes SESSION_NAME_RE: `present` is whether its pane runs claude. A
  // non-claude session still appears (`present: false`) so the agent-done edge
  // can see its attachment on the very sample where claude has exited. A session with an
  // unroundtrippable name is left out: every downstream route validates names
  // and would reject it, so it must not become a key anyone acts on.
  // `state`/`cause`/`ts` appear only when the on-box Claude Code hook wrote a
  // marker (claudeAgentHooks.js) — hook-only statusing: pane output timing is
  // never consulted, so a claude pane with no marker carries no state (the
  // deliberate cue that the box needs a setup rerun). A marker for a session
  // that is not listed, or whose pane is not claude, is stale and inert.
  // The displayed state comes from deriveAgentState with the caller's seen
  // watermark (`seenOf(session)`): `ready/stop` is `done` until the operator
  // has looked at that turn's end, `ready/start` is `idle` (nothing finished,
  // so nothing to acknowledge). The watermark is compared against the marker's
  // own ts and never against a clock, so time passing can never re-arm `done`;
  // only a new marker (a later ts) can.
  // Legacy fields for the box's configured session (opts.sessionName):
  // `agent` = agents[sessionName]?.state; `agentPresent` stays pane-based and
  // its sole consumer is the agent-done edge, where it keeps a one-poll marker
  // gap (claude restarting in place) from reading as the agent exiting.
  // `agentAttached` is a SESSION property, set whenever the configured session
  // exists, so suppression still sees attachment on the sample where claude
  // has already exited.
  const { sessionName, seenOf } = opts;
  if (Array.isArray(s.sessions)) {
    const agents = {};
    for (const sess of s.sessions) {
      if (!sess || !SESSION_NAME_RE.test(String(sess.name))) continue;
      const present = /^claude(-|$)/.test(String(sess.paneCmd || ''));
      const entry = { present, attached: !!sess.attached };
      if (!present) { agents[sess.name] = entry; continue; }
      const mark = s.agentMarks && s.agentMarks[sess.name];
      if (mark) {
        const seen = typeof seenOf === 'function' ? seenOf(sess.name) : undefined;
        entry.state = deriveAgentState(mark, seen);
        entry.cause = mark.cause;
        entry.ts = mark.ts;
      }
      agents[sess.name] = entry;
    }
    sample.agents = agents;
    if (sessionName) {
      const sess = s.sessions.find((x) => x.name === sessionName);
      if (sess) {
        sample.agentAttached = !!sess.attached;
        if (/^claude(-|$)/.test(String(sess.paneCmd || ''))) {
          sample.agentPresent = true;
          const st = agents[sessionName] && agents[sessionName].state;
          if (st) sample.agent = st;
        }
      }
    }
  }
  return sample;
}

export function initThresholdState() {
  // cpuSeeded: cpu% is delta-derived on cgroup hosts, so the sample right after
  // a restart carries no cpuPct. Seeding defers to the first sample that
  // actually observes one — otherwise a persistently-hot box would look like a
  // fresh crossing and replay a threshold event on every restart.
  return { cpu: false, cpuStreak: 0, cpuSeeded: true, mem: false, disk: false, agents: undefined };
}

// Pure edge detector. Reachability/auth edges compare prev↔next (stateless).
// Metric-threshold edges use `state` + hysteresis so a box that stays hot fires
// once; cpu additionally needs two consecutive over-samples (it is spiky). A
// nullish `prev` means this is the box's first sample: seed the threshold state
// to match current values but emit nothing (a restart must not replay
// down/over for boxes already in that state). Returns { events, state }.
export function classifyTransitions(prev, next, thresholds, state) {
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

  // Agent edges, per session over `sample.agents` (see sampleOf). `st.agents`
  // is the PREVIOUS map and is always the last one taken from a successful
  // probe: a failed probe's sample has no `agents` key, so it neither emits
  // nor replaces it, and the box coming back is compared against what it
  // looked like before it went away rather than read as a first appearance.
  // A session with no previous entry (first appearance, restart) emits nothing.
  //   agent-blocked: working|done|idle -> blocked (carries `cause`)
  //   agent-input:   working|blocked   -> done
  //   agent-done:    had a state, now absent from the map or no longer present (claude exited)
  // Hook state is the sole source (a single-poll edge is a real transition; the
  // box's own background-work gate in claudeAgentHooks.js keeps `Stop` pauses
  // awaiting background work from reading as done, so there is no settle window
  // here). blocked/input are suppressed while the session is attached — watching
  // the terminal is its own notification; agent-done checks BOTH ends, since the
  // user may attach in the final poll interval. agent-done also requires the
  // session to be ABSENT: a present entry with no state is a marker gap (claude
  // restarting in place) not an exit, and `!next.stopped` — a Proxmox-stopped
  // box carries no sessions, so absence there is not an observation.
  if (next.agents) {
    const before = st.agents || {};
    for (const [session, now] of Object.entries(next.agents)) {
      const was = before[session] && before[session].state;
      if (!was || now.attached) continue;
      if (now.state === 'blocked' && (was === 'working' || was === 'done' || was === 'idle')) {
        events.push({ kind: 'agent-blocked', session, cause: now.cause });
      } else if (now.state === 'done' && (was === 'working' || was === 'blocked')) {
        events.push({ kind: 'agent-input', session });
      }
    }
    if (next.up && !next.stopped) {
      for (const [session, was] of Object.entries(before)) {
        const now = next.agents[session];
        if (!was.state || was.attached || (now && (now.present || now.attached))) continue;
        events.push({ kind: 'agent-done', session });
      }
    }
    st.agents = next.agents;
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
export function createHealthHistory({
  maxSamples = 120,
  maxEvents = 200,
  thresholds = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 },
  load = () => [],
  save = () => {},
  now = () => Date.now(),
  onEvent = null,
} = {}) {
  const series = new Map();      // boxId -> Sample[]
  const lastSample = new Map();  // boxId -> Sample
  const threshState = new Map(); // boxId -> threshold state
  const loaded = load();
  const events = Array.isArray(loaded) ? loaded.slice(-maxEvents) : []; // oldest first
  let seq = events.reduce((m, e) => Math.max(m, e.seq || 0), 0);
  const listeners = new Set();
  if (typeof onEvent === 'function') listeners.add(onEvent);

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

  return {
    record(snapshot, boxes) {
      const at = now();
      const present = new Set();
      let emitted = 0;
      for (const box of boxes) {
        present.add(box.id);
        const status = snapshot[box.id];
        if (!status) continue;
        const sample = sampleOf(status, at, { sessionName: box.sessionName });
        const ring = series.get(box.id) || [];
        ring.push(sample);
        while (ring.length > maxSamples) ring.shift();
        series.set(box.id, ring);

        const prev = lastSample.get(box.id);
        const { events: evs, state } = classifyTransitions(prev, sample, thresholds, threshState.get(box.id));
        threshState.set(box.id, state);
        lastSample.set(box.id, sample);
        for (const ev of evs) {
          const out = { boxId: box.id, label: box.label || box.host, host: box.host, t: at, kind: ev.kind };
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
    },
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
  };
}
