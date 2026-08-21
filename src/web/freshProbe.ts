// On-demand status refresh policy for controls that must be current the moment
// they are used.
//
// GET /api/status serves the server's cached snapshot (statusPoller, 30s) and
// the tab re-reads it on its own 30s interval, so a change made on the box —
// a tmux window opened with `prefix-c` — could take a full minute to reach the
// pane header's session/window dropdown. POST /api/boxes/:id/probe re-probes
// one box now; this decides WHEN that is worth doing.
//
// The dropdown is reached for with the pointer, which means two events for one
// gesture (enter, then down) and any number of them if the user worries it open
// and shut. Three rules keep that honest:
//   - single-flight per box: the second caller joins the first probe rather
//     than starting another;
//   - a short freshness window: a probe that just landed answers the next
//     caller from what it already fetched;
//   - a caller-side wait cap: the click path holds the native picker shut until
//     its refresh resolves, so an unreachable box must not become a dead click.
//     Capping abandons the WAIT, never the probe — a late answer still lands in
//     the snapshot and still counts as fresh.
//
// A failed probe resolves the caller (a stale dropdown is not an error worth
// interrupting a click for) and is deliberately NOT recorded as fresh, so the
// next reach retries instead of trusting an answer that never arrived.

export interface FreshProbeDeps {
  // Probe one box and fold the answer into whatever the caller renders from.
  probe: (id: string) => Promise<unknown>;
  now?: () => number;
  freshMs?: number;
}

export interface FreshProbe {
  refresh(id: string, opts?: { waitMs?: number }): Promise<void>;
}

export function createFreshProbe({ probe, now = Date.now, freshMs = 2000 }: FreshProbeDeps): FreshProbe {
  const inFlight = new Map<string, Promise<void>>();
  const lastOk = new Map<string, number>();

  function start(id: string): Promise<void> {
    const running = inFlight.get(id);
    if (running) return running;
    // Started synchronously, not off a microtask: the click path races this
    // against a wait cap, so every millisecond before the request leaves is a
    // millisecond of dead click. A probe that throws synchronously is folded
    // into the same rejection path as one that rejects.
    let started: Promise<unknown>;
    try { started = Promise.resolve(probe(id)); } catch (e) { started = Promise.reject(e); }
    const p = started
      .then(() => { lastOk.set(id, now()); }, () => { /* stale, not broken: the next reach retries */ })
      .finally(() => { if (inFlight.get(id) === p) inFlight.delete(id); });
    inFlight.set(id, p);
    return p;
  }

  return {
    refresh(id, opts = {}) {
      const at = lastOk.get(id);
      if (at != null && now() - at < freshMs && !inFlight.has(id)) return Promise.resolve();
      const p = start(id);
      const waitMs = opts.waitMs;
      if (waitMs == null) return p;
      // Race, not cancel: `p` owns the probe and always finishes it.
      return Promise.race([p, new Promise<void>((res) => setTimeout(res, waitMs))]);
    },
  };
}
