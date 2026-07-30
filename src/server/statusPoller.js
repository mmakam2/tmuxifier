import { mapWithConcurrency } from './concurrency.js';

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
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
}) {
  let snapshot = {};
  let timer = null;
  let inFlight = null;
  const fastTracking = new Map();

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
        // The merge below stamps this entry's proxmox fields either way, so a
        // skipped box still reports its state — it just reports it for free.
        next[b.id] = stopped.has(b.id) ? { reachable: false } : await statusChecker.checkBox(b);
      });
      // Only defer to the enricher's merge when it actually produced something —
      // a null `pve` (no enricher, or one that threw) leaves the plain SSH
      // snapshot as the wholesale swap, same single-assignment shape as before.
      snapshot = pve && statusEnricher
        ? statusEnricher.merge(next, boxes, pve)
        : next;
      if (history) {
        // History must never affect status availability: the snapshot is already
        // swapped, so a bug here can't blank /api/status.
        try { history.record(snapshot, boxes); } catch { /* swallowed on purpose */ }
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
