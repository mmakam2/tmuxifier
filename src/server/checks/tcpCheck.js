import net from 'node:net';

// Reachability only: a completed TCP handshake is the whole assertion. The
// socket is destroyed immediately so a probe never holds a connection open on
// the target.
//
// Like runHttpCheck, this never throws and never rejects — a refused
// connection, a DNS failure, a timeout, and a malformed stored definition are
// all just the check failing. A throw here would abort the runner's whole due
// cycle, so every other check scheduled alongside it would silently go unrun.
//
// That is why nothing is read off `check` above the try: data/checks.json is a
// mutable file that checkTypes.js does not re-validate on read, and net.connect
// throws synchronously (ERR_SOCKET_BAD_PORT) on a missing or out-of-range port
// — inside a Promise executor that surfaces as a rejection, which is just as
// fatal to the cycle as a throw.
export function runTcpCheck(check, { now = () => Date.now() } = {}) {
  const started = now();
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      try { sock?.destroy(); } catch { /* already gone */ }
      resolve({ ok, detail, latencyMs: now() - started });
    };
    try {
      const timeoutMs = check?.timeoutMs || 10000;
      const host = check?.target?.host;
      const port = check?.target?.port;
      sock = net.connect({ host, port });
      sock.setTimeout(timeoutMs, () => done(false, `timed out after ${timeoutMs}ms`));
      sock.once('connect', () => done(true, `connected to ${host}:${port}`));
      sock.once('error', (e) => done(false, e?.message || 'connection failed'));
    } catch (e) {
      done(false, e?.message || 'connection failed');
    }
  });
}
