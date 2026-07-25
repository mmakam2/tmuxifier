import { mapWithConcurrency } from './concurrency.js';

// Scheduling only. The runner decides *when* a check runs and translates its
// result into occurrences; it never decides whether anything is worth telling
// the operator — that is alertPolicy.js, and keeping the two apart is what makes
// the notification rules testable without a scheduler.
//
// Recovery deliberately requires two consecutive successes: a flapping check
// would otherwise emit a resolve-and-refire pair every cycle, which is its own
// kind of drowning.
const RESOLVE_AFTER_OK = 2;

export function createCheckRunner({
  checkStore, dispatcher, eventLog, deps = {},
  now = () => Date.now(), intervalMs = 5000, concurrency = 4,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  jitter = (ms) => Math.floor(Math.random() * ms),
  maxEventsPerCheckPerHour = 60,
}) {
  const state = new Map();
  let timer = null;
  let inFlight = null;

  const entry = (id) => {
    if (!state.has(id)) {
      state.set(id, {
        lastRunAt: null, nextRunAt: 0, ok: null, consecutiveOk: 0, consecutiveFail: 0,
        detail: '', latencyMs: null,
        // Rolling hour used by the flood ceiling below.
        windowStart: null, windowCount: 0,
      });
    }
    return state.get(id);
  };

  // Split out of execute() so a secret-resolution failure (see runDue below)
  // can be recorded the same way a dispatch failure is, without needing to
  // fabricate a dispatcher call for a check whose secret never resolved.
  async function recordResult(check, result) {
    const s = entry(check.id);
    const ts = now();
    s.lastRunAt = ts;
    // Jitter spreads same-interval checks so they do not all fire on the same
    // tick and stampede a shared target.
    s.nextRunAt = ts + check.intervalSec * 1000 + jitter(1000);
    s.ok = result.ok;
    s.detail = result.detail;
    s.latencyMs = result.latencyMs;

    if (result.ok) {
      s.consecutiveFail = 0;
      s.consecutiveOk += 1;
      // resolvedPending is set by any failure and cleared only once two
      // successes have landed, which is what stops a flapping check from
      // emitting a resolve-and-refire pair every cycle.
      if (s.resolvedPending && s.consecutiveOk >= RESOLVE_AFTER_OK) {
        s.resolvedPending = false;
        await eventLog.append({
          via: 'check', source: `check:${check.id}`, key: `check:${check.id}`, norm: null,
          severity: check.severity, state: 'resolved',
          title: `${check.label} recovered`, body: result.detail || '',
        });
      }
    } else {
      s.consecutiveOk = 0;
      s.consecutiveFail += 1;
      s.resolvedPending = true;
      // A check misconfigured to run every 10s against a permanently broken
      // target would otherwise append thousands of identical lines an hour.
      // Past the ceiling, stop appending individual occurrences and say so
      // once: the disk, the fold, and the operator's attention are all
      // protected by the same move.
      //
      // The cap is announced rather than enforced silently — a check that just
      // stopped reporting is indistinguishable from one that recovered, and
      // "quietly stopped telling you things" is the failure mode this whole
      // system exists to prevent. One append with a computed title, then quiet
      // for the rest of the hour.
      if (s.windowStart === null || ts - s.windowStart >= 3600000) {
        s.windowStart = ts;
        s.windowCount = 0;
      }
      s.windowCount += 1;
      const capped = s.windowCount > maxEventsPerCheckPerHour;
      if (!capped || s.windowCount === maxEventsPerCheckPerHour + 1) {
        await eventLog.append({
          via: 'check', source: `check:${check.id}`, key: `check:${check.id}`, norm: null,
          severity: check.severity, state: 'firing',
          title: capped
            ? `${check.label} is flooding — capped at ${maxEventsPerCheckPerHour} events/hour`
            : `${check.label}: ${result.detail}`,
          body: result.detail || '',
        });
      }
    }
    return result;
  }

  async function execute(check) {
    let result;
    try {
      result = await dispatcher.run(check, deps);
    } catch (e) {
      // The dispatcher itself never throws (createCheckDispatcher awaits the
      // executor internally), but an executor is arbitrary injected code, so
      // this catch is the one place in the cycle that stands between a bad
      // executor and an unhandled rejection taking the whole cycle down.
      result = { ok: false, detail: e?.message || 'check threw', latencyMs: 0 };
    }
    return recordResult(check, result);
  }

  function runDue() {
    // Coalesce, exactly as statusPoller.js does: the tick fires on a fixed
    // cadence whether or not the previous cycle finished.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const checks = (await checkStore.listChecks()).filter((c) => c.enabled);
      const due = checks.filter((c) => now() >= entry(c.id).nextRunAt);
      // Listings are redacted, so resolve the sealed secret only for the checks
      // actually about to run. The decrypted value lives in memory for the
      // duration of one probe and never enters a listing, a route response, or
      // the event log.
      await mapWithConcurrency(due, concurrency, async (c) => {
        let full;
        try {
          full = await checkStore.getCheck(c.id, { withSecret: true });
        } catch (e) {
          // secretBox.open() throws synchronously on a bad auth tag (a
          // corrupted sealed value, or cookieSecret rotated after the check
          // was saved) — a real failure mode, not a defensive nicety. Left
          // unguarded, this throw would escape mapWithConcurrency's worker
          // loop: the worker dies mid-iteration (dropping every check still
          // queued behind this one in that worker), Promise.all rejects, and
          // runDue() itself rejects — logging NOTHING for any check that
          // cycle, including this one. That is strictly worse than "one check
          // reported wrong": it is the monitor going silent. Recording it as
          // an ordinary failed check (using the redacted listing `c` already
          // in hand, since a fresh `getCheck` won't return one) keeps this
          // check's own failure visible and lets every other due check in the
          // cycle still run.
          return recordResult(c, {
            ok: false, detail: `secret resolution failed: ${e?.message || 'unknown error'}`, latencyMs: 0,
          });
        }
        return execute(full || c);
      });
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    runDue,
    async runOne(id) {
      const check = await checkStore.getCheck(id, { withSecret: true });
      if (!check) return null;
      return execute(check);
    },
    getState: () => Object.fromEntries([...state.entries()].map(([k, v]) => [k, { ...v }])),
    async start() {
      await runDue();
      timer = setIntervalFn(() => { runDue().catch(() => {}); }, intervalMs);
      return timer;
    },
    stop() { if (timer != null) { clearIntervalFn(timer); timer = null; } },
  };
}
