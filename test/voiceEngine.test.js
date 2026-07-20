import { test, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createVoiceEngine } from '../src/server/voiceEngine.js';

const started = [];
afterEach(async () => { while (started.length) await started.pop()(); });

// A fake `spawn` whose child is a real HTTP server speaking whisper-server's
// /inference contract. Only the process boundary is faked: the engine's fetch,
// multipart encoding, readiness parsing and lifecycle all run for real.
// `gate`, when provided, is a mutable `{ wait }` holder: the server awaits
// `gate.wait()` before responding to each request. Defaults to an
// already-resolved wait so ordinary tests see the original instant-reply
// behavior; a test can swap in a controlled, not-yet-resolved wait to
// deterministically hold a specific request "in flight" for as long as it
// needs, rather than relying on how fast a real HTTP round trip happens to be.
function fakeSpawn({ reply = { text: 'hello world' }, readyLine = true, crashAfter = null, gate = null } = {}) {
  const calls = [];
  const fn = (bin, argv) => {
    const port = Number(argv[argv.indexOf('--port') + 1]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    let served = 0;
    const server = http.createServer(async (req, res) => {
      served += 1;
      if (crashAfter !== null && served > crashAfter) {
        server.close();
        child.emit('exit', 1, null);
        req.destroy();
        return;
      }
      if (gate) await gate.wait();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
    const close = () => new Promise((r) => server.close(() => r()));
    started.push(close);
    server.listen(port, '127.0.0.1', () => {
      if (readyLine) child.stdout.emit('data', Buffer.from(`whisper server listening at http://127.0.0.1:${port}\n`));
    });
    child.kill = () => { child.killed = true; void close(); child.emit('exit', 0, 'SIGTERM'); };
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

test('rejects with 503 when the child never signals readiness', async () => {
  const spawn = fakeSpawn({ readyLine: false });
  const engine = makeEngine(spawn, { readyTimeoutMs: 120 });
  await expect(engine.transcribe(WAV)).rejects.toMatchObject({ status: 503 });
  expect(engine.state()).toBe('stopped');
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
