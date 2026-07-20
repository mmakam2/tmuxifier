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

// Tail of the child's combined stdout/stderr kept for diagnostics, capped so
// a long warm session can never grow this unboundedly. The real binary
// (verified against vendor/whisper/examples/server/server.cpp) has eleven
// unconditional print sites per request across both streams -- roughly 365
// bytes of stderr alone -- so keeping only the last few KiB is plenty of
// context for "why did the last transcription fail" without accumulating.
const OUTPUT_RING_BYTES = 8192;

function createOutputRing(capBytes) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      if (buf.length > capBytes) buf = buf.subarray(buf.length - capBytes);
    },
    text() { return buf.toString('utf8'); },
  };
}

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
  // Bounds a single /inference call. Sized generously like readyTimeoutMs
  // (whisper.cpp turns a maxSeconds clip into text well inside real time even
  // on modest hardware) because its job isn't a tight SLA -- it only has to
  // guarantee SOME request eventually settles if the child wedges. Without
  // this, a hung child leaves the promise pending forever: inFlight never
  // drops to 0, armIdle() (guarded on inFlight > 0) never re-arms, teardown()
  // never runs, and every subsequent dictation 429s until Tmuxifier itself is
  // restarted.
  inferenceTimeoutMs = 120000,
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

      // Drain both piped streams unconditionally, starting immediately (before
      // readiness is even established) and for the child's whole lifetime.
      // Node leaves piped child streams paused until something reads them, so
      // with no listener the 64 KiB kernel pipe buffer is the only sink for
      // the real binary's per-request stdout/stderr diagnostics; after
      // roughly 160 transcriptions in one warm window the child blocks inside
      // its own write() call mid-request. Piping into a small ring buffer
      // (rather than 'ignore') means an operator has something to read when a
      // transcription fails, since the engine otherwise captures nothing at
      // all from the child.
      const output = createOutputRing(OUTPUT_RING_BYTES);
      c.stdout.on('data', (chunk) => output.push(chunk));
      c.stderr.on('data', (chunk) => output.push(chunk));

      await waitForReady(c, p);

      // A crash *after* startup invalidates the warm child; the next request
      // spawns a fresh one rather than fetching into a closed port.
      c.on('exit', (code, signal) => {
        if (child === c) {
          const tail = output.text();
          log(`[voice] whisper exited (code ${code}, signal ${signal})${tail ? `\n${tail}` : ''}`);
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
      res = await fetchImpl(`http://127.0.0.1:${port}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(inferenceTimeoutMs),
      });
    } catch (e) {
      // Covers a genuine timeout/abort as well as any other request failure.
      // Tearing the child down here (rather than only on its own 'exit'
      // event) is what lets the *next* request spawn a fresh, healthy child
      // instead of retrying against -- or queueing behind -- one that just
      // proved it hangs. Safe to call unconditionally: teardown() is a no-op
      // once the child is already gone (e.g. it crashed independently and its
      // own 'exit' listener already tore it down).
      teardown();
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

    // Bounded by a concurrency cap, not a FIFO queue: `queued`/`inFlight` are
    // just counters, so requests under queueLimit run concurrently rather
    // than being serialized -- this only caps how many may be in flight or
    // waiting on the child at once, converting overflow into a fast 429
    // rather than an unbounded pile-up.
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
