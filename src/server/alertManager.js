import { foldEvents } from './alertFold.js';
import { decideAlert, DEFAULT_THRESHOLDS } from './alertPolicy.js';

// The evaluation loop: fold the append-only logs into alerts, ask the policy
// engine about each one, record the answer, and deliver the ones that clear the
// bar. The cooldown watermark is re-derived from the decision log rather than
// held in memory, so a restart never re-notifies an alert it already sent.
export function createAlertManager({
  eventLogs, decisionLog, stateStore, channels = [],
  now = () => Date.now(), thresholds = DEFAULT_THRESHOLDS,
  lookbackMs = 7 * 86400000, intervalMs = 30000,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
}) {
  let timer = null;
  // Coalesce overlapping calls (the timer firing while a manual evaluate() is
  // still running, or two manual calls racing) onto one in-flight run. Without
  // this, two concurrent runs would both read a not-yet-updated decision log,
  // both conclude nothing was notified yet, and both deliver - doubling sends.
  let inFlight = null;

  async function readEvents() {
    const since = now() - lookbackMs;
    const all = [];
    for (const log of eventLogs) all.push(...await log.readSince(since, now()));
    return all;
  }

  async function lastNotifiedMap() {
    const since = now() - lookbackMs;
    const map = new Map();
    for (const d of await decisionLog.readSince(since, now())) {
      // Only a *delivered* notification starts a cooldown. A notify:failed
      // reached nobody, so treating it as a send would silence the retry.
      if (d.reason === 'notified') map.set(d.key, d.ts);
    }
    return map;
  }

  async function evaluate() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const [events, rules, notified] = await Promise.all([readEvents(), stateStore.getRules(), lastNotifiedMap()]);
      const alerts = foldEvents(events, { nowMs: now(), windowMs: thresholds.warnWindowMs });
      const out = [];
      for (const alert of alerts) {
        const { notify, reason } = decideAlert({
          alert, rules, nowMs: now(), lastNotifiedAt: notified.get(alert.key) ?? null, thresholds,
        });
        if (!notify) {
          out.push(await decisionLog.append({ key: alert.key, reason, notify: false, error: null }));
          continue;
        }
        let error = null;
        for (const ch of channels) {
          // A channel that throws instead of returning {ok:false} must not
          // abort this alert's delivery loop, and must not abort the outer
          // loop over the remaining alerts either - the .catch() here turns a
          // thrown exception into the same shape as an ordinary failed send.
          const res = await ch.deliver(alert, reason).catch((e) => ({ ok: false, error: e?.message || 'channel threw' }));
          if (!res.ok) error = res.error || 'delivery failed';
        }
        // Recorded only after delivery has actually resolved (or failed), so
        // the decision log always reflects what really happened - never an
        // optimistic guess written ahead of the attempt.
        out.push(await decisionLog.append({
          key: alert.key, reason: error ? 'notify:failed' : 'notified', notify: !error, error,
        }));
      }
      return out;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    evaluate,
    async listAlerts() {
      const [events, decisions] = await Promise.all([readEvents(), decisionLog.readSince(now() - lookbackMs, now())]);
      const latest = new Map();
      for (const d of decisions) latest.set(d.key, d.reason);
      return foldEvents(events, { nowMs: now(), windowMs: thresholds.warnWindowMs })
        .map((a) => ({ ...a, reason: latest.get(a.key) || null }));
    },
    async start() {
      await evaluate();
      timer = setIntervalFn(() => { evaluate().catch(() => {}); }, intervalMs);
      return timer;
    },
    stop() { if (timer != null) { clearIntervalFn(timer); timer = null; } },
  };
}
