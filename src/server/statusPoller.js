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
  history = null,
}) {
  let snapshot = {};
  let timer = null;
  let inFlight = null;

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
      // Probe in small batches (same reason as the old handler) and swap the
      // snapshot in wholesale so readers never see a half-built map and a removed
      // box drops out.
      const next = {};
      await mapWithConcurrency(boxes, concurrency, async (b) => {
        next[b.id] = await statusChecker.checkBox(b);
      });
      snapshot = next;
      if (history) {
        // History must never affect status availability: the snapshot is already
        // swapped, so a bug here can't blank /api/status.
        try { history.record(next, boxes); } catch { /* swallowed on purpose */ }
      }
      return snapshot;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    pollOnce,
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
