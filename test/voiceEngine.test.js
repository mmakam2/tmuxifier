import { test, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { spawn as spawnRealProcess } from 'node:child_process';
import { createVoiceEngine } from '../src/server/voiceEngine.js';

const started = [];
afterEach(async () => { while (started.length) await started.pop()(); });

// A fake `spawn` whose child is a real HTTP server speaking whisper-server's
// /inference contract. Only the process boundary is faked: the engine's fetch,
// multipart encoding, readiness probing and lifecycle all run for real.
// It never emits anything on stdout or stderr -- matching the real
// whisper-server binary, which prints all model-load diagnostics to stderr
// and never announces readiness on either stream. Readiness is therefore
// only ever observable by the port actually accepting a connection, same as
// production; see the "no readiness line" test below for the regression
// guard this protects.
// `gate`, when provided, is a mutable `{ wait }` holder: the server awaits
// `gate.wait()` before responding to each request. Defaults to an
// already-resolved wait so ordinary tests see the original instant-reply
// behavior; a test can swap in a controlled, not-yet-resolved wait to
// deterministically hold a specific request "in flight" for as long as it
// needs, rather than relying on how fast a real HTTP round trip happens to be.
function fakeSpawn({ reply = { text: 'hello world' }, crashAfter = null, gate = null } = {}) {
  const calls = [];
  const fn = (bin, argv) => {
    const port = Number(argv[argv.indexOf('--port') + 1]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    let served = 0;
    const server = http.createServer(async (req, res) => {
      // The engine's readiness probe hits `/`, distinct from the real
      // `/inference` calls -- it must not count toward crashAfter, or a
      // probe landing between two transcribes would shift the crash by one.
      if (req.url !== '/inference') {
        res.writeHead(200);
        res.end();
        return;
      }
      served += 1;
      if (crashAfter !== null && served > crashAfter) {
        server.close();
        child.emit('exit', 1, null);
        req.destroy();
        return;
      }
      // The real whisper-server binary unconditionally prints roughly a dozen
      // lines per request across stdout/stderr (~365 bytes of stderr alone --
      // see the I3 finding). Emitting a comparable amount here means the
      // engine's drain-listener code path is genuinely exercised by every
      // ordinary test in this file, not just the dedicated backpressure test
      // below (which is the one that can actually prove draining, since a
      // bare EventEmitter's 'data' event never blocks regardless of whether
      // anything is listening).
      child.stderr.emit('data', Buffer.from(`whisper_server: processing '<clip>' (16000 samples, 1.0 sec)\n`.repeat(5)));
      if (gate) await gate.wait();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    // closeAllConnections() (Node 18.2+) forcibly ends any still-open
    // connection before waiting on the close callback, so cleanup can never
    // hang behind a request a test deliberately left unanswered (e.g. the I4
    // fake-never-responds test).
    const close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
    started.push(close);
    server.listen(port, '127.0.0.1');
    child.kill = () => { child.killed = true; void close(); child.emit('exit', 0, 'SIGTERM'); };
    calls.push({ bin, argv, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// A fake `spawn` whose child never binds the port, never emits 'error', and
// never emits 'exit' -- it simply never becomes reachable, the way a genuinely
// wedged startup would look from the engine's point of view.
function fakeSpawnNeverReady() {
  const calls = [];
  const fn = (bin, argv) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ bin, argv, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

// Ephemeral ports, allocated per engine so parallel tests never collide.
let nextPort = 39000;
const pickPort = async () => nextPort++;

const WAV = Buffer.from('RIFF....WAVEfmt ');

function makeEngine(spawn, over = {}) {
  return createVoiceEngine({
    bin: '/fake/whisper-server', model: '/fake/model.bin',
    idleMs: 60000, readyTimeoutMs: 2000, spawn, pickPort, log: () => {}, ...over,
  });
}

test('spawns lazily on the first transcribe and reuses the warm child', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn);
  expect(engine.state()).toBe('stopped');

  expect(await engine.transcribe(WAV)).toBe('hello world');
  expect(spawn.calls.length).toBe(1);
  expect(engine.state()).toBe('ready');

  expect(await engine.transcribe(WAV)).toBe('hello world');
  expect(spawn.calls.length).toBe(1); // reused, not respawned

  await engine.stop();
});

test('passes the model and a loopback bind to the child', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn);
  await engine.transcribe(WAV);
  const { bin, argv } = spawn.calls[0];
  expect(bin).toBe('/fake/whisper-server');
  expect(argv).toContain('/fake/model.bin');
  expect(argv[argv.indexOf('--host') + 1]).toBe('127.0.0.1');
  await engine.stop();
});

test('shuts the child down after the idle timeout', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn, { idleMs: 60 });
  await engine.transcribe(WAV);
  expect(engine.state()).toBe('ready');
  await new Promise((r) => setTimeout(r, 140));
  expect(engine.state()).toBe('stopped');
  await engine.stop();
});

test('the idle timer is cancelled during a request, not merely reset', async () => {
  // The race this guards: a request arriving at the very end of an idle window
  // must not have its engine killed underneath it mid-transcription. The
  // second request is held open on a controlled gate (not a fixed sleep) so
  // it is deterministically still in flight when the original idle deadline
  // would have fired — a plain fast fake reply could beat that deadline by
  // luck and mask a "reset only, not cancelled" bug.
  const gate = { wait: () => Promise.resolve() };
  const spawn = fakeSpawn({ gate });
  const engine = makeEngine(spawn, { idleMs: 50 });
  await engine.transcribe(WAV);            // engine warm, idle timer armed

  await new Promise((r) => setTimeout(r, 40)); // 40ms into a 50ms window
  let release = () => {};
  gate.wait = () => new Promise((r) => { release = r; }); // block the next request open
  const slow = engine.transcribe(WAV);
  await new Promise((r) => setTimeout(r, 40)); // would have fired by now; slow is still pending
  try {
    expect(engine.state()).toBe('ready'); // still alive because a request is in flight
  } finally {
    // Always release the gated response, even on assertion failure -- otherwise
    // a genuine regression here would hang the fake server (and the suite)
    // instead of failing fast.
    release();
  }
  expect(await slow).toBe('hello world');
  await engine.stop();
});

test('rejects with 503 when the child never becomes reachable', async () => {
  // Unlike fakeSpawn, this child never binds the port -- readiness must time
  // out (the deadline path), not resolve. A short readyTimeoutMs keeps the
  // test fast while still exercising the real timeout->kill->reject path.
  const spawn = fakeSpawnNeverReady();
  const engine = makeEngine(spawn, { readyTimeoutMs: 120 });
  await expect(engine.transcribe(WAV)).rejects.toMatchObject({ status: 503 });
  expect(engine.state()).toBe('stopped');
  await engine.stop();
});

// Regression guard for the bug this change fixes: the real whisper-server
// (verified against whisper.cpp v1.9.1) prints all model-load diagnostics to
// stderr and prints nothing at all -- and in particular never a "listening
// at" or other readiness line -- on either stream. A readiness check that
// depends on matching such a line would hang until readyTimeoutMs and reject
// with 503 on every real transcription. This test fails against that old
// regex-based implementation because fakeSpawn (see above) never emits any
// stdout/stderr data at all; readiness must come from the port itself
// accepting a connection.
test('becomes ready by probing the port, with no readiness line on stdout or stderr', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn);
  expect(await engine.transcribe(WAV)).toBe('hello world');
  expect(engine.state()).toBe('ready');
  await engine.stop();
});

test('respawns after the child crashes', async () => {
  const spawn = fakeSpawn({ crashAfter: 1 });
  const engine = makeEngine(spawn);
  expect(await engine.transcribe(WAV)).toBe('hello world');
  await expect(engine.transcribe(WAV)).rejects.toMatchObject({ status: 502 });
  expect(engine.state()).toBe('stopped');
  await engine.stop();
});

test('rejects with 429 once the queue is full', async () => {
  const spawn = fakeSpawn();
  const engine = makeEngine(spawn, { queueLimit: 2 });
  const inflight = [engine.transcribe(WAV), engine.transcribe(WAV), engine.transcribe(WAV)];
  const results = await Promise.allSettled(inflight);
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(rejected.length).toBe(1);
  expect(rejected[0].reason.status).toBe(429);
  await engine.stop();
});

test('stop() is idempotent and safe before any spawn', async () => {
  const engine = makeEngine(fakeSpawn());
  await engine.stop();
  await engine.stop();
  expect(engine.state()).toBe('stopped');
});

// I4: without an inference timeout, a wedged child leaves inFlight stuck
// above 0 forever -- armIdle() never re-arms, teardown() never runs, and
// every dictation after this one would 429 until Tmuxifier itself restarts.
// `gate.wait()` here never resolves, standing in for a child that accepted
// the request but will never answer it -- the /inference response itself
// hangs, not the connection.
test('an inference that never responds rejects in bounded time and the next request gets a fresh child', async () => {
  const gate = { wait: () => new Promise(() => {}) }; // never resolves
  const spawn = fakeSpawn({ gate });
  const engine = makeEngine(spawn, { inferenceTimeoutMs: 50 });

  await expect(engine.transcribe(WAV)).rejects.toMatchObject({ status: 502 });
  expect(spawn.calls.length).toBe(1);
  expect(engine.state()).toBe('stopped'); // the wedged child was torn down, not left dangling

  // Release the gate so a stray retry against the stale child (there should
  // be none) can't hang the suite; the fresh child below reads the gate too,
  // since fakeSpawn's request handler reads `gate.wait` fresh on every call.
  gate.wait = () => Promise.resolve();

  expect(await engine.transcribe(WAV)).toBe('hello world');
  expect(spawn.calls.length).toBe(2); // a genuinely fresh child, not the wedged one
  await engine.stop();
}, 10000);

// I3 regression guard: the real whisper-server binary is not a well-behaved
// Node child -- its printf/fprintf calls are raw, unbuffered libc write()
// syscalls against the stdout/stderr pipes. If nothing reads those pipes,
// the kernel buffer (64 KiB on Linux) fills and the child's *next* write()
// blocks it mid-request. fakeSpawn above cannot reproduce that: emitting a
// 'data' event on a bare EventEmitter never blocks regardless of whether
// anything is listening, so it cannot tell a present drain listener from a
// removed one. This test spawns a REAL child process that performs a real,
// synchronous, unbuffered write (fs.writeSync, bypassing Node's own
// stdout/stderr stream buffering) so an actually-undrained pipe would
// actually block it, the same way the real binary would. A single write
// larger than the 64 KiB pipe buffer proves it either way, so this needs
// only two requests rather than the ~160 real production would take before
// wedging -- "shrink the volume ... by writing a larger chunk per request."
test('drains real child stdio so large per-request writes cannot wedge the child', async () => {
  const port = nextPort++;
  const chunkBytes = 200 * 1024; // well past the 64 KiB pipe buffer in one write
  const script = [
    "const http = require('http');",
    "const fs = require('fs');",
    `const chunk = Buffer.alloc(${chunkBytes}, 'x');`,
    'const server = http.createServer((req, res) => {',
    "  if (req.url !== '/inference') { res.writeHead(200); res.end(); return; }",
    '  fs.writeSync(2, chunk);', // raw blocking write, like the real binary's fprintf(stderr, ...)
    '  fs.writeSync(1, chunk);', // and stdout, per the same eleven-print-sites finding
    "  res.writeHead(200, { 'content-type': 'application/json' });",
    "  res.end(JSON.stringify({ text: 'hello world' }));",
    '});',
    `server.listen(${port}, '127.0.0.1');`,
  ].join('\n');

  let realChild = null;
  const spawn = () => {
    realChild = spawnRealProcess(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    return realChild;
  };
  // Safety net alongside engine.stop() below: if an assertion throws before
  // that runs, this still reaps the real OS process rather than leaking it.
  started.push(() => new Promise((resolve) => {
    if (!realChild || realChild.exitCode !== null || realChild.killed) return resolve();
    realChild.once('exit', () => resolve());
    try { realChild.kill('SIGKILL'); } catch { resolve(); }
  }));

  const engine = makeEngine(spawn, { pickPort: async () => port, inferenceTimeoutMs: 5000 });
  // Two sequential requests against the warm child: if the drain listeners
  // were ever removed, the first request's raw write would already exceed
  // the pipe buffer and block the child forever, so this would time out
  // (via inferenceTimeoutMs above) rather than resolve quickly.
  expect(await engine.transcribe(WAV)).toBe('hello world');
  expect(await engine.transcribe(WAV)).toBe('hello world');
  await engine.stop();
}, 10000);
