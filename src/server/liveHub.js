// Real-time agent state, server -> browser.
//
// Open tabs used to learn about a change by asking every 30 s. The hub lets
// the server say "box X changed" the moment it knows, over the /live WebSocket
// (server.js). Like the box-side watch stream (agentWatch.js) this is a
// TRIGGER, not a data path: the only thing ever sent is `{"box":"<id>"}`, and
// the tab answers by fetching that box through the ordinary authenticated
// routes. So the stream carries no state to leak or to drift, a missed nudge
// costs nothing (the 30 s polls remain the backstop), and every byte the
// browser renders still arrives through http.ts.
//
// A WebSocket rather than server-sent events on purpose: browsers cap HTTP/1.1
// connections at six per origin ACROSS tabs, and an EventSource holds one for
// as long as its tab lives — a handful of tabs would starve the app's own
// fetches. WebSockets have their own, far higher budget.
//
// A client is `{ send(text), ping(), close(code, reason), terminate() }`.

// Box ids are store UUIDs or `__local__`. Anything else is not published.
const BOX_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function createLiveHub({
  // One per open tab of a single operator; the cap only bounds a runaway.
  maxClients = 32,
  pingMs = 25000,
  // A stream is authenticated once, at the upgrade. Closing it on a schedule
  // makes the tab reconnect and be checked again, so an expired or revoked
  // session stops receiving nudges within this window (logout closes at once).
  maxAgeMs = 15 * 60 * 1000,
  now = () => Date.now(),
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  const clients = new Map(); // client -> { addedAt, alive }
  let timer = null;

  function stopTimerIfIdle() {
    if (clients.size === 0 && timer !== null) { clearIntervalFn(timer); timer = null; }
  }
  function drop(client) {
    if (!clients.delete(client)) return false;
    stopTimerIfIdle();
    return true;
  }
  function tick() {
    const t = now();
    for (const [client, meta] of [...clients]) {
      if (t - meta.addedAt >= maxAgeMs) {
        drop(client);
        try { client.close(4000, 'renew'); } catch { /* already gone */ }
      } else if (!meta.alive) {
        // No pong since the last ping: a half-open connection.
        drop(client);
        try { client.terminate(); } catch { /* already gone */ }
      } else {
        meta.alive = false;
        try { client.ping(); } catch { drop(client); }
      }
    }
  }

  return {
    // Returns the remove function, or null when the hub is full.
    add(client) {
      if (clients.size >= maxClients) return null;
      clients.set(client, { addedAt: now(), alive: true });
      if (timer === null) {
        timer = setIntervalFn(tick, pingMs);
        timer?.unref?.();
      }
      return () => { drop(client); };
    },
    alive(client) {
      const meta = clients.get(client);
      if (meta) meta.alive = true;
    },
    publish(boxId) {
      if (typeof boxId !== 'string' || !BOX_ID_RE.test(boxId)) return;
      const text = JSON.stringify({ box: boxId });
      for (const client of [...clients.keys()]) {
        try { client.send(text); } catch {
          drop(client);
          try { client.terminate(); } catch { /* already gone */ }
        }
      }
    },
    closeAll(code = 1001, reason = 'closing') {
      for (const client of [...clients.keys()]) {
        clients.delete(client);
        try { client.close(code, reason); } catch { /* already gone */ }
      }
      stopTimerIfIdle();
    },
    size: () => clients.size,
  };
}
