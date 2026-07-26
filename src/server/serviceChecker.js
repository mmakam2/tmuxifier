import { mapWithConcurrency } from './concurrency.js';
import { checkService } from './serviceCheck.js';

// One server-side sweep loop for service liveness, modeled on statusPoller.js:
// the /api/services/status handler serves the cached snapshot, so check volume
// is independent of how many dashboard tabs are open. Nothing is persisted —
// the dashboard is current-state-only by design.
export function createServiceChecker({
  store, check = checkService, intervalMs = 30000, concurrency = 8,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  const everyMs = Math.max(5000, Number(intervalMs) || 30000);
  let snapshot = { checkedAt: null, results: {} };
  let timer = null;
  let inFlight = null;

  function pollOnce() {
    if (inFlight) return inFlight; // coalesce overlapping sweeps (see statusPoller.js)
    inFlight = (async () => {
      const services = (await store.listServices()).filter((s) => s?.check?.kind !== 'none');
      const next = {};
      await mapWithConcurrency(services, concurrency, async (s) => {
        next[s.id] = await check(s);
      });
      snapshot = { checkedAt: new Date().toISOString(), results: next };
      return snapshot;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    pollOnce,
    getSnapshot: () => snapshot,
    async start() {
      await pollOnce();
      timer = setIntervalFn(() => { pollOnce().catch(() => {}); }, everyMs);
      return timer;
    },
    stop() {
      if (timer != null) { clearIntervalFn(timer); timer = null; }
    },
  };
}
