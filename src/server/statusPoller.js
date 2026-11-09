import { mapWithConcurrency } from './concurrency.js';
import { LOCAL_BOX_ID } from './localAgent.js';

// A single, server-side status poll loop. Status used to be probed on demand in
// the /api/status handler, so every open dashboard tab drove its own SSH probe
// cycle — N tabs = N x the connections, a burst that host-side rate-limiters/IPS
// ban. This polls each box once per interval regardless of how many tabs are
// watching; the handler just serves the cached snapshot. Factory with injected
// deps so it's testable without real timers or SSH (see test/statusPoller.test.js).
export function createStatusPoller({
  store, statusChecker, intervalMs = 30000, concurrency = 4,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  history = null, statusEnricher = null,
  localAgent = null, localSession = 'local', localSampleTimeoutMs = 5000,
  // Called after every sweep with (boxes, snapshot). index.js uses it to keep
  // the real-time agent watch streams in step with what the sweep found
  // (agentWatch.js): streams start and stop on the sweep's cadence only.
  onCycle = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  let snapshot = {};
  let timer = null;
  let inFlight = null;
  const fastTracking = new Map();

  // Ordering between the sweep and refreshAgents. Both read the same box and
  // either can finish first, so "last writer wins" would let an OLDER read
  // overwrite a newer one — the board flips back, and the next sweep then
  // reports the same transition a second time (a duplicate push). One counter
  // orders the events that matter:
  //   probeStart[id]  when the current sweep began probing that box
  //   agentFresh[id]  when a refresh last applied its answer
  // A refresh applied AFTER the sweep started reading the box is at least as
  // new as the sweep's read, so its agent fields are carried over the swap;
  // one applied before is older and the sweep's read stands. `swapGen` covers
  // the opposite overlap: a refresh still in flight when a sweep swaps must not
  // apply an answer that predates the sweep's, so it probes again. A marker
  // that changes after either read raises its own trigger, so whichever way a
  // race falls the state converges on the newest marker and only moves forward.
  let seq = 0;
  let swapGen = 0;
  const probeStart = new Map();
  const agentFresh = new Map();
  // The Host Shell's equivalents (it is sampled, not probed, and lives only in
  // the history).
  let localGen = 0;
  let localFresh = null; // { seq, status }

  const localBox = () => ({ id: LOCAL_BOX_ID, label: 'Host Shell', host: 'localhost', sessionName: localSession });
  // Deadline-raced, not merely try/caught. `inFlight` clears only in the
  // .finally() of pollOnce and every pollOnce coalesces onto it, so a sampler
  // that never settles (a marker file that is a FIFO, a wedged tmux) would not
  // just lose the Host Shell's own state — it would freeze status polling for
  // the entire fleet. The Host Shell is a convenience riding these rails; it
  // must never be able to stop them.
  const sampleLocal = () => Promise.race([
    Promise.resolve().then(() => localAgent.sample()),
    new Promise((r) => { const t = setTimeout(() => r(null), localSampleTimeoutMs); t.unref?.(); }),
  ]).catch(() => null);
  // Only the Host Shell's own session is tracked. The client can open and
  // acknowledge just that one, so any other host tmux session would latch
  // `done` forever with no way to clear it.
  const ownOnly = (local) => (Array.isArray(local.sessions)
    ? { ...local, sessions: local.sessions.filter((s) => s && s.name === localSession) }
    : local);

  function pollOnce() {
    // Coalesce overlapping polls: the interval fires on a fixed cadence whether
    // or not the previous cycle finished, so a slow cycle (several down boxes
    // at full probe timeout) would otherwise overlap the next — doubling
    // history.record per interval (defeating the two-consecutive-samples cpu
    // debounce) and letting an older poll finish later and overwrite a newer
    // snapshot with stale data (spurious down/up events).
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const boxes = await store.listBoxes();
      // PVE state is collected BEFORE the probe cycle, not alongside it, because
      // it now gates the cycle: a container Proxmox reports stopped has no sshd
      // to answer, so probing it spends a full ConnectTimeout on a foregone
      // conclusion — and since the snapshot swaps wholesale, that wait lands on
      // every other box's freshness too. One /cluster/resources call per host is
      // far cheaper than that. Best-effort: a throwing/rejecting collector
      // degrades to `null`, which fails open — every box gets probed, as before.
      const pve = statusEnricher
        ? await Promise.resolve().then(() => statusEnricher.collect(boxes)).catch(() => null)
        : null;
      const stopped = new Set((pve || []).filter((r) => r && r.state === 'stopped').map((r) => r.boxId));
      // Probe in small batches (same reason as the old handler) and swap the
      // snapshot in wholesale so readers never see a half-built map and a removed
      // box drops out.
      const next = {};
      await mapWithConcurrency(boxes, concurrency, async (b) => {
        probeStart.set(b.id, ++seq);
        // The merge below stamps this entry's proxmox fields either way, so a
        // skipped box still reports its state — it just reports it for free.
        next[b.id] = stopped.has(b.id) ? { reachable: false } : await statusChecker.checkBox(b);
      });
      // A refresh that applied after this sweep began reading its box holds
      // the newer agent state (see the ordering note above): carry it across.
      // A new object, never a mutation — checkBox may hand the same result to
      // a coalesced caller or keep it as a backoff's last-known status.
      for (const [id, appliedAt] of agentFresh) {
        const mine = next[id];
        const live = snapshot[id];
        if (mine && mine.reachable && live && live.reachable && appliedAt > (probeStart.get(id) ?? 0)) {
          const carried = { ...mine, tmux: live.tmux, sessions: live.sessions };
          if (live.agentMarks) carried.agentMarks = live.agentMarks; else delete carried.agentMarks;
          next[id] = carried;
        }
      }
      agentFresh.clear();
      for (const id of [...probeStart.keys()]) if (!(id in next)) probeStart.delete(id);
      // Only defer to the enricher's merge when it actually produced something —
      // a null `pve` (no enricher, or one that threw) leaves the plain SSH
      // snapshot as the wholesale swap, same single-assignment shape as before.
      snapshot = pve && statusEnricher
        ? statusEnricher.merge(next, boxes, pve)
        : next;
      swapGen += 1;
      if (history) {
        // History must never affect status availability: the snapshot is already
        // swapped, so a bug here can't blank /api/status.
        try {
          let recorded = boxes;
          let own = null;
          if (localAgent) {
            // The Host Shell rides the history rails as a pseudo-box (badge,
            // pane chip, agent events) but must never leak into /api/status —
            // hence the local copy below rather than touching `snapshot`.
            const localStart = ++seq;
            const local = await sampleLocal();
            // The pseudo-box is ALWAYS in `recorded` while a sampler is
            // configured: record() prunes the seen watermark, series and last
            // sample of every box absent from `recorded`, so dropping it on a
            // lost race would wipe the Host Shell's acknowledgement and re-arm
            // a `done` the operator already saw. With no sample the snapshot
            // simply has no `__local__` key — record() skips a box with no
            // status without pruning it.
            recorded = [...boxes, localBox()];
            if (local) own = ownOnly(local);
            // Same rule as agentFresh: a local refresh applied after this
            // sample was started is the newer read.
            if (localFresh && localFresh.seq > localStart) own = localFresh.status;
          }
          // Read `snapshot` only now, after the await above: a refreshAgents
          // that landed while the Host Shell was being sampled has already
          // recorded its state, and recording the pre-await object would move
          // that box backwards.
          const snap = own ? { ...snapshot, [LOCAL_BOX_ID]: own } : snapshot;
          localGen += 1;
          history.record(snap, recorded);
        } catch { /* swallowed on purpose */ }
      }
      if (onCycle) {
        try { onCycle(boxes, snapshot); } catch { /* the watch must never break the sweep */ }
      }
      return snapshot;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  // Probe exactly one box and patch it into the snapshot. This is the fast
  // track's unit of work: the caller asked about one container's boot, and
  // sweeping the fleet to answer that cost ~300 extra probes per container
  // start on a 10-box fleet, with every sweep's slowest box delaying the one
  // answer actually wanted (E3).
  //
  // Everything pollOnce does per box is preserved: the PVE gate first (a
  // stopped container has no sshd, so probing it burns a full ConnectTimeout on
  // a foregone conclusion) and the enricher's merge after, so the entry still
  // carries its proxmox fields.
  //
  // History is deliberately NOT recorded here. `history.record(snapshot, boxes)`
  // deletes the series of every box absent from `boxes`, so recording a single
  // box would wipe the rest of the fleet's history; and the regular sweep is
  // the honest cadence anyway — a lifecycle action on one box should not
  // densify another's series.
  async function probeOne(boxId) {
    const box = (await store.listBoxes()).find((b) => b.id === boxId);
    if (!box) return null;
    const pve = statusEnricher
      ? await Promise.resolve().then(() => statusEnricher.collect([box])).catch(() => null)
      : null;
    const stopped = new Set((pve || []).filter((r) => r && r.state === 'stopped').map((r) => r.boxId));
    const one = { [box.id]: stopped.has(box.id) ? { reachable: false } : await statusChecker.checkBox(box) };
    const merged = pve && statusEnricher ? statusEnricher.merge(one, [box], pve) : one;
    // A new object rather than a mutation, so a reader holding the previous
    // snapshot never observes it change underneath — the same invariant the
    // wholesale swap in pollOnce keeps.
    snapshot = { ...snapshot, [box.id]: merged[box.id] };
    return snapshot[box.id];
  }

  // The real-time path: a box's watch stream reported a marker change
  // (agentWatch.js). One LIGHT probe — sessions, windows, markers; no metrics —
  // patched into the snapshot and recorded as an agent-only update
  // (history.recordAgents), so the change shows and notifies now rather than at
  // the next sweep. Resolves true when something was applied.
  //
  // It has no say over reachability. A box the sweep has not seen up is not
  // probed, and a failed light probe changes nothing: only the sweep marks a
  // box down, with its backoff and its stale-master handling.
  async function refreshAgents(boxId) {
    if (boxId === LOCAL_BOX_ID) return refreshLocal();
    if (!statusChecker.checkAgents) return false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const box = (await store.listBoxes()).find((b) => b.id === boxId);
      if (!box || !snapshot[box.id]?.reachable) return false;
      const gen = swapGen;
      const res = await statusChecker.checkAgents(box);
      if (!res) return false;
      // A whole sweep swapped while this probe was out: its read is the newer
      // one. Ask again rather than apply an answer from before it.
      if (gen !== swapGen) continue;
      const cur = snapshot[box.id];
      if (!cur?.reachable) return false;
      const entry = { ...cur, tmux: res.tmux, sessions: res.sessions };
      if (res.agentMarks) entry.agentMarks = res.agentMarks; else delete entry.agentMarks;
      // A new object rather than a mutation, as in probeOne.
      snapshot = { ...snapshot, [box.id]: entry };
      agentFresh.set(box.id, ++seq);
      if (history) { try { history.recordAgents(box, entry); } catch { /* history never affects status */ } }
      return true;
    }
    return false;
  }

  // The Host Shell's refresh: the same sampler the sweep uses, recorded as an
  // agent-only update. Never enters the snapshot.
  async function refreshLocal() {
    if (!localAgent || !history) return false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const gen = localGen;
      const local = await sampleLocal();
      if (!local) return false;
      if (gen !== localGen) continue;
      const own = ownOnly(local);
      localFresh = { seq: ++seq, status: own };
      try { return history.recordAgents(localBox(), own); } catch { return false; }
    }
    return false;
  }

  // Fast-track after a lifecycle action. A container is not reachable the
  // instant its PVE start task completes — sshd is still coming up — so a
  // single refresh would only capture "still down". Re-probe on a short cadence
  // until this box answers, so the UI tracks the box's own boot time instead of
  // the poll interval. Bounded by timeoutMs: a box that never comes back must
  // not leave a probe loop running forever. One loop per box — a second caller
  // for the same box joins the first rather than racing it.
  function refreshUntil(boxId, { intervalMs: everyMs = 5000, timeoutMs = 180000 } = {}) {
    const existing = fastTracking.get(boxId);
    if (existing) return existing;
    const deadline = now() + timeoutMs;
    const loop = (async () => {
      for (;;) {
        // Clear this box's failure backoff first. The probe goes through
        // checkBox, which inside a backoff window returns the last-known
        // failure without touching SSH — and the first probe after a lifecycle
        // start always fails (sshd isn't up yet), opening a 30s window that
        // escalates to 60s and 90s. Without this reset the 5s cadence below is
        // decorative: the box is re-probed on the backoff schedule instead of
        // its own boot time, and a ~100s boot never lands inside the deadline.
        statusChecker.resetBackoff?.(boxId);
        const entry = await probeOne(boxId).catch(() => null);
        if (entry?.reachable) return true;
        if (now() >= deadline) return false;
        await sleep(everyMs);
      }
    })().finally(() => { fastTracking.delete(boxId); });
    fastTracking.set(boxId, loop);
    return loop;
  }

  return {
    pollOnce,
    // Exported so a route that just CHANGED something on a box can make the
    // next /api/status authoritative about it. /api/status serves the cached
    // snapshot, which only moves on the poll interval (30s by default), so a
    // caller that re-fetches status straight after acting would otherwise read
    // back the pre-action state and paint it over the action's own result.
    probeOne,
    refreshAgents,
    refreshUntil,
    getSnapshot: () => snapshot,
    async start() {
      await pollOnce(); // seed the cache so the first /api/status isn't empty
      timer = setIntervalFn(() => { pollOnce().catch(() => {}); }, intervalMs);
      return timer;
    },
    stop() {
      if (timer != null) { clearIntervalFn(timer); timer = null; }
    },
  };
}
