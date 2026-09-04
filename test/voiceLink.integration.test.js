// test/voiceLink.integration.test.js
import { test, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildServer } from '../src/server/server.js';
import { createStore } from '../src/server/store.js';
import { createBoxActions } from '../src/server/boxActions.js';
import { createVoiceLinks } from '../src/server/voiceLinks.js';
import { sshRun, sshRunStdin, sshPipe } from '../src/server/sshRun.js';
import { hashPassword, COOKIE_NAME } from '../src/server/auth.js';
import { buildProbeArgv } from '../src/server/sshCommand.js';
import { setupLocalBox } from './helpers/localBox.js';

let teardown;
afterEach(async () => { if (teardown) await teardown(); teardown = null; });
async function stopFeeder(pidfile) {
  // The writer's parent exits after its 2.5 s tail and hands the pidfile to
  // the feeder it forked; wait for that handover before stopping it.
  for (let i = 0; i < 60; i++) {
    let pid = 0;
    try { pid = Number((await fs.readFile(pidfile, 'utf8')).trim()) || 0; } catch {}
    if (pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch { return; }
      for (let j = 0; j < 300; j++) { try { process.kill(pid, 0); } catch { return; } await tick(10); }
      return;
    }
    await tick(100);
  }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture() {
  const lb = await setupLocalBox();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-vli-'));
  const config = {
    bindAddress: '127.0.0.1', port: 0, hostKeyPolicy: 'accept-new', graceSeconds: 5,
    passwordHash: await hashPassword('pw'), cookieSecret: 'sek', dataDir: dir,
    sshConfigPath: path.join(dir, 'nope'),
  };
  const store = createStore({ dataDir: dir, sshConfigPath: config.sshConfigPath });
  const saved = await store.addBox({ host: lb.box.host, sessionName: lb.session });
  // ssh's ControlPath socket is created by ssh itself, but never the directory
  // it lives in — production (index.js) mkdir's controlDir before wiring
  // boxActions; without it here, ControlMaster=auto fails with "unix_listener:
  // cannot bind to path .../cm/<hash>: No such file or directory" (ssh exits
  // 255), which voiceLinks.js's openSink().done then reports as a plain
  // writer-failed (4003) rather than the box's own exit 3 (4002).
  const controlDir = path.join(dir, 'cm');
  await fs.mkdir(controlDir, { recursive: true, mode: 0o700 });
  const boxActions = createBoxActions({
    run: (argv, opts) => sshRun(argv, { ...opts, env: lb.env }),
    runStdin: (argv, input, opts) => sshRunStdin(argv, input, { ...opts, env: lb.env }),
    pipe: (argv) => sshPipe(argv, { env: lb.env }),
    sshConfigFile: lb.sshConfigFile, controlDir,
  });
  const voiceLinks = createVoiceLinks({ openSink: ({ box }) => boxActions.openAudioSink(box), killGraceMs: 500 });
  const sessions = { open() { return {}; }, attach() {}, write() {}, resize() {}, detach() {}, close() {}, onExit() {} };
  const app = buildServer({ config, store, sessions, voiceLinks, statusChecker: { checkBox: async () => ({ reachable: true }) } });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address();
  const login = await app.inject({ method: 'POST', url: '/api/login', payload: { password: 'pw' } });
  const c = login.cookies.find((x) => x.name === COOKIE_NAME);
  teardown = async () => {
    voiceLinks.closeAll(); await app.close();
    // A finished link leaves a resident feeder holding the FIFO; stop it the
    // way a shutdown would before the fixture home is removed.
    await stopFeeder(path.join(lb.home, '.tmuxifier-voice', 'writer.pid'));
    await lb.cleanup(); await fs.rm(dir, { recursive: true, force: true });
  };
  return { lb, port, boxId: saved.id, cookie: `${c.name}=${c.value}` };
}
function connect(port, boxId, cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-link?box=${boxId}`, { headers: { cookie } });
  const texts = [];
  ws.on('message', (d, isBinary) => { if (!isBinary) texts.push(d.toString()); });
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  return { ws, texts, closed };
}
function drain(fd) {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try { n = fsSync.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') break; throw e; }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

test('a box that was never set up closes 4002 not-set-up', async () => {
  const { port, boxId, cookie } = await fixture();
  const { closed } = connect(port, boxId, cookie);
  expect(await closed).toEqual({ code: 4002, reason: 'not-set-up' });
}, 30000);

test('frames sent after ready land in the box FIFO byte-for-byte', async () => {
  const { lb, port, boxId, cookie } = await fixture();
  // Guard against a fixture PATH regression or a python3-less image silently
  // degrading to the `cat` fallback (voiceWriter.js): against a FIFO-less box
  // BOTH branches exit 3, and even-length frames pass through `cat`
  // byte-for-byte too, so nothing else in this test would notice the writer
  // wasn't the real Python program. One extra round trip, no FIFO needed yet.
  const pyProbe = await sshRun(
    buildProbeArgv(lb.box, 'command -v python3', { sshConfigFile: lb.sshConfigFile }),
    { env: lb.env },
  );
  expect(pyProbe.code, 'python3 must be on the fixture box PATH, or this test silently exercises the cat fallback instead of the real writer').toBe(0);
  // The layout buildVoiceLinkInstallScript() leaves on a prepared box: the
  // real FIFO is mic.fifo, and `mic` (what ~/.asoundrc names) is a symlink
  // parked on an absent path until a writer swaps it onto the FIFO.
  const vdir = path.join(lb.home, '.tmuxifier-voice');
  await fs.mkdir(vdir, { recursive: true, mode: 0o700 });
  const fifo = path.join(vdir, 'mic.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  // Pin the FIFO's format: the bytes sent must come out verbatim on any host.
  fsSync.writeFileSync(path.join(vdir, 'format'), 's16le\n');
  const dev = path.join(vdir, 'mic');
  await fs.symlink(path.join(vdir, 'mic.absent'), dev);
  const { ws, texts, closed } = connect(port, boxId, cookie);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  for (let i = 0; i < 100 && texts.length === 0; i++) await tick(50);
  expect(texts).toEqual(['ready']);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    const frames = [0, 1, 2].map((k) => Buffer.alloc(640, 0x10 + k));
    const got = [];
    for (const f of frames) { ws.send(f); await tick(30); got.push(drain(fd)); }
    for (let i = 0; i < 40 && Buffer.concat(got).length < 1920; i++) { await tick(50); got.push(drain(fd)); }
    expect(Buffer.concat(got).subarray(0, 1920)).toEqual(Buffer.concat(frames));
  } finally {
    fsSync.closeSync(fd);
  }
  // While the link is up the device points at the FIFO; the writer restores
  // /dev/zero on its way out, which is what keeps an unlinked Claude Code
  // press from blocking forever in snd_pcm_open.
  expect(await fs.readlink(dev)).toBe(fifo);
  // ws.close() with no code sends a close frame with no status payload, which
  // the `ws` library (both sides) then reports as 1005 ("no status
  // received") rather than any code the server's onClose ever chose —
  // confirmed against a bare echo server with no Tmuxifier code in the loop.
  // An explicit 1000 is what a real client hangs up with, and what's actually
  // under test here (the pipe delivering bytes), not this library quirk.
  ws.close(1000);
  expect((await closed).code).toBe(1000);
}, 40000);
