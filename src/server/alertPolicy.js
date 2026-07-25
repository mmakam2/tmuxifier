// Deterministic and pure: this function alone decides what may interrupt the
// operator. No model, no heuristic, no I/O. Every branch returns a reason code,
// because a system that withholds silently is indistinguishable from a broken one.
//
// warnWindowMs is carried here (not used below) so callers have one shared
// config object to pass both into Task 2's foldEvents (which computes
// recentCount over that window) and into this function's thresholds — the
// window itself is already baked into alert.recentCount by the time it
// reaches decideAlert.
export const DEFAULT_THRESHOLDS = {
  warnPersistMs: 15 * 60 * 1000,
  warnRepeatCount: 3,
  warnWindowMs: 60 * 60 * 1000,
  cooldownMs: 6 * 60 * 60 * 1000,
};

export function decideAlert({
  alert, rules = { mutes: [], overrides: {} }, nowMs, lastNotifiedAt = null,
  thresholds = DEFAULT_THRESHOLDS,
}) {
  const mutes = rules.mutes || [];
  const override = (rules.overrides || {})[alert.key] || {};

  // A resolved alert can never notify, regardless of mute/severity/cooldown —
  // checked first so its reason is never masked by an unrelated rule.
  if (alert.state === 'resolved') return { notify: false, reason: 'skipped:resolved' };
  // Mute is an explicit operator decision, so it is reported ahead of any
  // automatic suppression — "I silenced this" beats "it is in cooldown" or
  // "this is only informational".
  if (mutes.includes(alert.key) || mutes.includes(alert.source)) {
    return { notify: false, reason: 'suppressed:muted' };
  }
  const severity = override.severity || alert.severity;
  // Checked before cooldown so an info alert always reports skipped:info,
  // never a cooldown-based reason it would never have earned by notifying.
  if (severity === 'info') return { notify: false, reason: 'skipped:info' };

  const cooldownMs = override.cooldownMs ?? thresholds.cooldownMs;
  if (lastNotifiedAt !== null && nowMs - lastNotifiedAt < cooldownMs) {
    return { notify: false, reason: 'suppressed:cooldown' };
  }
  if (severity === 'critical') return { notify: true, reason: 'notified' };

  const repeatGate = override.failuresBeforeNotify ?? thresholds.warnRepeatCount;
  const persisted = alert.firstTs !== null && nowMs - alert.firstTs >= thresholds.warnPersistMs;
  const repeated = alert.recentCount >= repeatGate;
  if (persisted || repeated) return { notify: true, reason: 'notified' };
  return { notify: false, reason: 'held:below-persistence' };
}
