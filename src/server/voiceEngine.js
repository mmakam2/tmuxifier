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
  readyTimeoutMs = 30000,
  spawn = nodeSpawn,
  pickPort = ephemeralPort,
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

      await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
        const timer = setTimeout(
          () => { try { c.kill('SIGTERM'); } catch {} done(reject, err('whisper did not become ready', 503)); },
          readyTimeoutMs,
        );
        // whisper-server announces itself on stdout once bound.
        const onData = (buf) => { if (/listening at/i.test(String(buf))) done(resolve); };
        c.stdout.on('data', onData);
        c.stderr.on('data', (b) => { if (/listening at/i.test(String(b))) done(resolve); });
        c.on('error', (e) => done(reject, err(`whisper failed to start: ${e.message}`, 503)));
        c.on('exit', (code) => done(reject, err(`whisper exited during startup (code ${code})`, 503)));
      });

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
      res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
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
