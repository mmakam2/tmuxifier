import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';

// Lazily-spawned whisper.cpp server with an idle timeout.
//
// Chosen over spawn-per-request (which pays model load on every clip) and over
// an always-resident child (which holds ~0.85 GB permanently for small.en).
// The child is started on the first transcription, kept warm across a burst of
// dictation, and shut down once idle — so steady-state RAM cost is zero.
//
// Everything crossing a process or network boundary is injectable, which is
// what lets the tests run the real fetch/multipart/readiness code against a
// stub HTTP child rather than mocking the engine itself.

function err(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// How often to probe the port while waiting for the child to come up. Modest
// enough that a warm start (port already accepting connections) is still
// near-instant, since the first probe fires immediately and this interval
// only bounds the *next* one.
const READY_POLL_MS = 250;

// Ask the OS for a free port by binding :0 and reading it back. Racy in
// principle (the port could be taken between close and the child's bind), but
// this is a single-user local dashboard and the failure mode is a readiness
// timeout that respawns cleanly.
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function createVoiceEngine({
  bin,
  model,
  threads = 4,
  idleMs = 600000,
  queueLimit = 2,
  // whisper-server's own model load can take 30s+ on a cold page cache for a
  // large model (measured >30s for ggml-small.en.bin, 487 MB); warm, the port
  // is ready in under a second. 120s covers the first dictation after a
  // reboot without making a genuinely broken startup wait forever.
  readyTimeoutMs = 120000,
  spawn = nodeSpawn,
  pickPort = ephemeralPort,
  // Injected so tests can exercise the real readiness-probe and inference
  // code paths against a stub HTTP child instead of mocking the engine.
  fetch: fetchImpl = fetch,
  log = (msg) => console.error(msg),
} = {}) {
  let child = null;
  let port = 0;
  let starting = null;     // Promise while the child is coming up
  let idleTimer = null;
  let inFlight = 0;
  let queued = 0;

  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  // Re-armed only when nothing is in flight. Cancelling for the duration of a
  // request (rather than merely resetting on use) is what closes the race
  // where a request starting at the end of an idle window has its engine
  // killed underneath it.
  function armIdle() {
    clearIdle();
    if (!child || inFlight > 0) return;
    idleTimer = setTimeout(() => { void teardown(); }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function teardown() {
    clearIdle();
    const c = child;
    child = null;
    port = 0;
    starting = null;
    if (c && !c.killed) {
      try { c.kill('SIGTERM'); } catch {}
    }
  }

  // Readiness is decided by actually probing the port whisper-server was told
  // to bind, not by parsing its logs. The real binary (verified against
  // whisper.cpp v1.9.1) prints all model-load diagnostics to stderr and never
  // prints anything at all on stdout, and never emits a "listening at" (or
  // any other) readiness announcement on either stream — so log-matching can
  // never work here. Probing what we actually depend on is also strictly
  // more robust than parsing text: it can't be broken by upstream changing
  // its logging, and it's true by construction. Any HTTP response counts as
  // ready (the root path may legitimately 404); only a connection-level
  // failure means "not ready yet".
  function waitForReady(c, p) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let probing = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(poller);
        c.removeListener('error', onError);
        c.removeListener('exit', onExit);
        fn(arg);
      };
      const deadline = setTimeout(
        () => { try { c.kill('SIGTERM'); } catch {} finish(reject, err('whisper did not become ready', 503)); },
        readyTimeoutMs,
      );
      // Fail fast on a real startup failure rather than waiting out the
      // whole deadline.
      const onError = (e) => finish(reject, err(`whisper failed to start: ${e.message}`, 503));
      const onExit = (code) => finish(reject, err(`whisper exited during startup (code ${code})`, 503));
      c.on('error', onError);
      c.on('exit', onExit);

      const probe = async () => {
        if (settled || probing) return;
        probing = true;
        try {
          await fetchImpl(`http://127.0.0.1:${p}/`);
          finish(resolve);
        } catch {
          // Connection-level failure (nothing bound yet) -- keep polling.
        } finally {
          probing = false;
        }
      };

      const poller = setInterval(() => { void probe(); }, READY_POLL_MS);
      void probe(); // try immediately so a warm start is near-instant
    });
  }

  async function start() {
    if (child) return;
    if (starting) return starting;
    starting = (async () => {
      const p = await pickPort();
      const argv = [
        '-m', model,
        '--host', '127.0.0.1',
        '--port', String(p),
        '-t', String(threads),
      ];
      const c = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

      await waitForReady(c, p);

      // A crash *after* startup invalidates the warm child; the next request
      // spawns a fresh one rather than fetching into a closed port.
      c.on('exit', (code, signal) => {
        if (child === c) {
          log(`[voice] whisper exited (code ${code}, signal ${signal})`);
          teardown();
        }
      });

      child = c;
      port = p;
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  async function runInference(wav) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
    } catch (e) {
      throw err(`whisper request failed: ${e.message}`, 502);
    }
    if (!res.ok) throw err(`whisper returned ${res.status}`, 502);
    const body = await res.json().catch(() => null);
    if (!body || typeof body.text !== 'string') throw err('whisper returned no text', 502);
    return body.text;
  }

  return {
    state() {
      if (child) return 'ready';
      return starting ? 'starting' : 'stopped';
    },

    // Serialized behind a bounded queue: whisper-server processes one clip at
    // a time, so letting requests pile up would only convert latency into
    // memory pressure. Overflow is a fast 429 rather than an unbounded wait.
    async transcribe(wav) {
      if (queued >= queueLimit) throw err('voice engine busy', 429);
      queued += 1;
      clearIdle();
      inFlight += 1;
      try {
        await start();
        return await runInference(wav);
      } finally {
        queued -= 1;
        inFlight -= 1;
        armIdle();
      }
    },

    async stop() {
      teardown();
    },
  };
}
