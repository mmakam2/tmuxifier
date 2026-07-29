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

  // Fast-track after a lifecycle action. A container is not reachable the
  // instant its PVE start task completes — sshd is still coming up — so a
  // single refresh would only capture "still down". Re-sweep on a short cadence
  // until this box answers, so the UI tracks the box's own boot time instead of
  // the poll interval. Bounded by timeoutMs: a box that never comes back must
  // not leave a sweep loop running forever. One loop per box — a second caller
  // for the same box joins the first rather than racing it.
  function refreshUntil(boxId, { intervalMs: everyMs = 5000, timeoutMs = 180000 } = {}) {
    const existing = fastTracking.get(boxId);
    if (existing) return existing;
    const deadline = now() + timeoutMs;
    const loop = (async () => {
      for (;;) {
        // Clear this box's failure backoff first. The sweep goes through
        // checkBox, which inside a backoff window returns the last-known
        // failure without touching SSH — and the first probe after a lifecycle
        // start always fails (sshd isn't up yet), opening a 30s window that
        // escalates to 60s and 90s. Without this reset the 5s cadence below is
        // decorative: the box is re-probed on the backoff schedule instead of
        // its own boot time, and a ~100s boot never lands inside the deadline.
        statusChecker.resetBackoff?.(boxId);
        await pollOnce().catch(() => {});
        if (snapshot[boxId]?.reachable) return true;
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
