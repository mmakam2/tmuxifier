// The only check that fires because nothing happened. Everything else in this
// system reacts to a signal; this one reacts to its absence, which is the only
// construction that can catch a backup that never ran.
//
// That inversion is also what makes a false green uniquely dangerous here. Every
// comparison with NaN is false, so an unconfigured or non-numeric window would
// make `age > windowMs` false and report healthy — silence read as success,
// which is precisely the outcome this check type exists to prevent. So the
// window is validated before it is trusted, and a check-in whose own timestamp
// is unusable does not count as a check-in.
export async function runHeartbeatCheck(check, { checkinLog, now = () => Date.now() } = {}) {
  const started = now();
  const fail = (detail) => ({ ok: false, detail, latencyMs: now() - started });
  try {
    const windowSec = Number(check?.target?.windowSec);
    const graceSec = Number(check?.target?.graceSec || 0);
    if (!Number.isFinite(windowSec) || windowSec <= 0 || !Number.isFinite(graceSec) || graceSec < 0) {
      return fail('heartbeat window is not configured');
    }
    const windowMs = (windowSec + graceSec) * 1000;
    // Look back twice the window so a long-silent heartbeat still finds its last
    // check-in and can report how long it has been, rather than just "never".
    const events = await checkinLog.readSince(now() - Math.max(windowMs * 2, 86400000), now());
    const mine = events.filter((e) => e.key === `check:${check.id}` && Number.isFinite(e.ts));
    const last = mine.length ? mine[mine.length - 1] : null;
    if (!last) return fail('never checked in');
    const age = now() - last.ts;
    if (age > windowMs) {
      const mins = Math.floor(age / 60000);
      return fail(`no check-in for ${mins}m (expected every ${Math.floor(windowMs / 60000)}m)`);
    }
    return { ok: true, detail: `checked in ${Math.floor(age / 1000)}s ago`, latencyMs: now() - started };
  } catch (e) {
    return fail(e?.message || 'heartbeat could not be evaluated');
  }
}
