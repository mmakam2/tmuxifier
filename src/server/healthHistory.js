// Mirrors src/web/statusDot.ts `cpuLoadPct`: normalize load average by core count
// to a percent, only usable when both are present. Kept in sync by hand (server
// is .js, that helper is .ts) — the display and the sample must read the same.
function cpuLoadPct(m) {
  if (!m || m.load1 == null || !m.cpus) return undefined;
  return Math.round((m.load1 / m.cpus) * 100);
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
  // Agent state for the box's configured session only (opts.sessionName).
  // PRESENCE comes from the pane command alone; the box clock only decides
  // working vs waiting. A poll whose __META__ line failed (no boxNowSec) must
  // neither erase the agent (false agent-done) nor fabricate an observed idle
  // state: a fabricated 'working' would make the recovery poll look like a
  // genuine working->waiting edge and fire a false agent-input one poll after
  // the gap. So no clock => 'unknown', which sits on neither side of the
  // input edge (at worst a real transition inside the gap is missed once).
  // agentAttached is a SESSION property, set whenever the configured session
  // exists, so suppression still sees attachment on the sample where claude
  // has already exited.
  const { sessionName, agentIdleSec } = opts;
  if (sessionName && Array.isArray(s.sessions)) {
    const sess = s.sessions.find((x) => x.name === sessionName);
    if (sess) {
      sample.agentAttached = !!sess.attached;
      if (/^claude(-|$)/.test(String(sess.paneCmd || ''))) {
        if (m && m.boxNowSec != null) {
          const idleSec = m.boxNowSec - Number(sess.activity || 0);
          sample.agent = idleSec >= Number(agentIdleSec ?? 45) ? 'waiting' : 'working';
        } else {
          sample.agent = 'unknown';
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
  return { cpu: false, cpuStreak: 0, cpuSeeded: true, mem: false, disk: false };
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

  // Agent edges (box's configured session only). Suppressed while that session
  // is attached — watching the terminal is its own notification; agent-done
  // checks BOTH ends of the edge, since the user may attach in the final poll
  // interval. 'unknown' (clock unavailable) matches neither side of the input
  // edge but still counts as presence for agent-done. Edge-triggered like the
  // others: no emission without a prev sample. agent-done additionally
  // requires !next.stopped: a Proxmox-stopped box carries no `sessions` (see
  // sampleOf), so it always looks like "agent disappeared" — but that absence
  // is a stopped container, not a live probe's observation, so it must not
  // read as the agent finishing.
  if (prev) {
    if (prev.agent === 'working' && next.agent === 'waiting' && !next.agentAttached) {
      events.push({ kind: 'agent-input' });
    } else if (prev.agent && !next.agent && next.up && !next.stopped && !prev.agentAttached && !next.agentAttached) {
      events.push({ kind: 'agent-done' });
    }
  }

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
// Settings → Notifications) — onEvent below is an unused server-push seam
// (webhook/email) that nothing currently subscribes to.
export function createHealthHistory({
  maxSamples = 120,
  maxEvents = 200,
  thresholds = { cpu: 90, mem: 90, disk: 90, hysteresis: 5 },
  agentIdleSec = 45,
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
    // Unused server-push seam (webhook/email would subscribe here; browser
    // notifications instead poll GET /api/health/events client-side). A
    // listener error must never break the poll.
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
        const sample = sampleOf(status, at, { sessionName: box.sessionName, agentIdleSec });
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
