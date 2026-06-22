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
}) {
  let snapshot = {};
  let timer = null;

  async function pollOnce() {
    const boxes = await store.listBoxes();
    // Probe in small batches (same reason as the old handler) and swap the
    // snapshot in wholesale so readers never see a half-built map and a removed
    // box drops out.
    const next = {};
    await mapWithConcurrency(boxes, concurrency, async (b) => {
      next[b.id] = await statusChecker.checkBox(b);
    });
    snapshot = next;
    return snapshot;
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
