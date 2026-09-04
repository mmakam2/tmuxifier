import { test, expect, afterEach } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVoiceWriterRemote, WRITER_PROGRAM, WRITER_EXIT_NOT_SET_UP, VOICE_FIFO_REL, VOICE_DEV_REL } from '../src/server/voiceWriter.js';

const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// Runs the remote command the way the box's login shell would, with HOME
// pointed at a temp dir. Returns the child so tests can stream stdin. The
// remote `exec`s python3, so child.pid IS the writer's pid — which is what
// the single-writer pidfile assertions below compare against.
function runWriter(home) {
  return spawn('/bin/sh', ['-c', buildVoiceWriterRemote()], { env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'] });
}
const exitOf = (child) => new Promise((r) => child.on('close', (c) => r(c)));
async function home() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-'));
  dirs.push(dir);
  return dir;
}
// The box-side layout the install script (claudeVoiceLink.js) leaves behind:
// the real FIFO is mic.fifo, and `mic` — what ~/.asoundrc names — is a
// symlink parked on an ABSENT path, so an idle capture open fails cleanly.
// Not /dev/zero and not the FIFO: alsa-lib's null slave has no clock, so any
// source that never blocks (/dev/zero, or EOF) makes capture spin at CPU
// speed — measured at 331 million frames/s — and the reader buffers that
// "audio" until the box is out of memory. Only a live writer paces.
// `mode` pins what the FIFO carries (the `format` file the writer honours
// ahead of its /proc/asound/cards probe): s16le keeps the byte-pattern tests
// exact on a host whose card listing would otherwise select the 48 kHz path.
async function fifoIn(dir, mode = 's16le') {
  const d = path.join(dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  const fifo = path.join(d, 'mic.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const dev = path.join(d, 'mic');
  const absent = path.join(d, 'mic.absent');
  await fs.symlink(absent, dev);
  if (mode) await fs.writeFile(path.join(d, 'format'), mode + '\n');
  return { fifo, dev, absent, pidfile: path.join(d, 'writer.pid') };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
// Waits for the device symlink to name `want`, up to ~2 s.
async function waitLink(dev, want) {
  for (let i = 0; i < 200; i++) {
    let got = null;
    try { got = await fs.readlink(dev); } catch { /* mid-swap */ }
    if (got === want) return true;
    await tick(10);
  }
  return false;
}
// Waits for writer.pid to name `want`, up to ~2 s. Polled rather than read
// once: the pid is written by the box-side program, so a test that reads it
// the instant it spawns (or the instant a predecessor's exit is observed) is
// racing the very write it means to assert.
async function waitPid(pidfile, want) {
  for (let i = 0; i < 200; i++) {
    let got = null;
    try { got = (await fs.readFile(pidfile, 'utf8')).trim(); } catch { /* not written yet */ }
    if (got === String(want)) return got;
    await tick(10);
  }
  return null;
}
const dirs = [];
async function readPid(pidfile) {
  try { return Number((await fs.readFile(pidfile, 'utf8')).trim()) || 0; } catch { return 0; }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitDead(pid, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) { if (!alive(pid)) return true; await tick(10); }
  return false;
}
// The resident feeder a finished link leaves behind is stopped the way a
// shutdown would stop it: SIGTERM with no successor in the pidfile.
async function stopFeeder(pidfile) {
  const pid = await readPid(pidfile);
  if (pid > 0 && alive(pid)) { process.kill(pid, 'SIGTERM'); expect(await waitDead(pid)).toBe(true); }
  return pid;
}
// The FIFO's pipe capacity as the kernel granted it: an unprivileged LXC
// whose host uid is over fs.pipe-user-pages-soft gets 8 KB pipes that
// cannot grow, and the writer sizes its pieces to whatever it got.
function pipeCap(fifo) {
  const out = execFileSync('python3', ['-c', 'import os,fcntl,sys\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK)\nprint(fcntl.fcntl(fd,1032))', fifo]);
  return Number(String(out).trim());
}
// utime + stime of a process, in clock ticks, from /proc.
async function cpuTicks(pid) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(f[11]) + Number(f[12]);
}
afterEach(async () => {
  for (const d of dirs.splice(0)) {
    const pid = await readPid(path.join(d, '.tmuxifier-voice', 'writer.pid'));
    if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
});
// Non-blocking read of everything currently in the FIFO.
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

test('the Python program contains no single quote and the remote interpolates nothing but $HOME', () => {
  expect(WRITER_PROGRAM).not.toContain("'");
  const remote = buildVoiceWriterRemote();
  expect(remote).toContain(`exec python3 -c '${WRITER_PROGRAM}'`);
  expect(WRITER_PROGRAM).toContain('mic.absent');
  // The resident feeder: the link writer forks it and detaches it.
  expect(WRITER_PROGRAM).toContain('os.fork()');
  expect(WRITER_PROGRAM).toContain('os.setsid()');
  // Audio is written in 250 ms chunks — Claude Code's whole read cycle — so
  // alsa-lib's one-read()-per-transfer file plugin never pads a short read.
  expect(WRITER_PROGRAM).toContain('READ = 4000');
  expect(WRITER_PROGRAM).toContain('READ = 19200');
  expect(WRITER_PROGRAM).toContain('F_GETPIPE_SZ');
  expect(WRITER_PROGRAM).toContain('/proc/asound/cards');
  // Single-instance is a kernel lock held for life, not a pidfile convention.
  expect(WRITER_PROGRAM).toContain('fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)');
  // No shell variable at all reaches the remote now that the cat fallback is
  // gone — no box, user or session value ever did, and the program derives
  // its own paths from $HOME inside python. Asserted as a set so a future
  // interpolation cannot slip in quietly.
  expect(remote.match(/\$\{?[A-Za-z_]\w*\}?/g)).toBeNull();
  expect(WRITER_EXIT_NOT_SET_UP).toBe(3);
  expect(VOICE_FIFO_REL).toBe('.tmuxifier-voice/mic.fifo');
  expect(VOICE_DEV_REL).toBe('.tmuxifier-voice/mic');
});

test('the remote has no cat fallback: without python3 it exits 3 and touches nothing', async () => {
  const remote = buildVoiceWriterRemote();
  expect(remote).not.toContain('cat >');
  expect(remote).toContain(`exit ${WRITER_EXIT_NOT_SET_UP}`);
  // A PATH with no python3 at all: /bin/sh is invoked by absolute path and
  // `command -v` is a builtin, so an empty directory is enough.
  const dir = await home();
  const { dev, absent } = await fifoIn(dir);
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-bin-'));
  try {
    const child = spawn('/bin/sh', ['-c', remote], { env: { PATH: binDir, HOME: dir }, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.destroy();
    const t0 = Date.now();
    expect(await exitOf(child)).toBe(WRITER_EXIT_NOT_SET_UP);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await fs.readlink(dev)).toBe(absent);
  } finally {
    try { await fs.rm(binDir, { recursive: true, force: true }); } catch {}
  }
});

test('exits 3 at once when the FIFO does not exist', async () => {
  const dir = await home();
  const child = runWriter(dir);
  child.stdin.end(Buffer.alloc(100));
  const t0 = Date.now();
  expect(await exitOf(child)).toBe(3);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test.skipIf(!hasPython)('never blocks without a reader, keeps at most the pipe, and hands the device to a resident feeder after stdin ends', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  const child = runWriter(dir);
  const exited = exitOf(child);
  child.stdin.end(Buffer.from(Array.from({ length: 100 * 1024 }, (_, i) => i & 0xff)));
  const t0 = Date.now();
  expect(await exited).toBe(0);
  // The 2.5 s silence tail, plus one piece-time per piece of this 100 KB
  // burst the full pipe would not take (a real link arrives at real time,
  // so that wait never accumulates).
  expect(Date.now() - t0).toBeLessThan(7000);
  // The link process is gone, but the device is still held: a detached feeder
  // now owns the FIFO and the pidfile, so the next Claude Code press on this
  // box reads paced silence rather than blocking (writerless FIFO) or
  // spinning (/dev/zero, EOF).
  expect(await fs.readlink(dev)).toBe(fifo);
  const feeder = await readPid(pidfile);
  expect(feeder).toBeGreaterThan(0);
  expect(feeder).not.toBe(child.pid);
  expect(alive(feeder)).toBe(true);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  const kept = drain(fd);
  fsSync.closeSync(fd);
  // Whatever the kernel let the pipe hold, plus the one piece the feeder's
  // blocked write lands the instant the drain makes room for it.
  expect(kept.length).toBeLessThanOrEqual(pipeCap(fifo) + 4000);
  expect(kept.length % 2).toBe(0);
  // A shutdown (SIGTERM with no successor claiming the pidfile) parks the
  // device on the absent path and clears the pidfile.
  await stopFeeder(pidfile);
  expect(await fs.readlink(dev)).toBe(absent);
  await expect(fs.access(pidfile)).rejects.toBeTruthy();
});

test.skipIf(!hasPython)('points the device at the FIFO while alive, records its pid, and passes both to the feeder on exit', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  const child = runWriter(dir);
  const exited = exitOf(child);
  expect(await waitLink(dev, fifo)).toBe(true);
  // The pidfile is what makes the writer single-instance; `exec python3`
  // keeps the shell's pid, so this is the very process feeding the FIFO.
  expect(await waitPid(pidfile, child.pid)).toBe(String(child.pid));
  child.stdin.end();
  expect(await exited).toBe(0);
  // The parent recorded the feeder's pid before leaving, so there is never a
  // moment when the pidfile names a dead process while the device is held.
  const feeder = await readPid(pidfile);
  expect(feeder).not.toBe(child.pid);
  expect(alive(feeder)).toBe(true);
  expect(await fs.readlink(dev)).toBe(fifo);
  await stopFeeder(pidfile);
  expect(await fs.readlink(dev)).toBe(absent);
  await expect(fs.access(pidfile)).rejects.toBeTruthy();
}, 20000);

test.skipIf(!hasPython)('a second writer takes over: the first exits at once with no tail, and only the second is heard', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  const a = runWriter(dir);
  const aExit = exitOf(a);
  expect(await waitLink(dev, fifo)).toBe(true);
  let fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    a.stdin.write(Buffer.alloc(8000, 0xaa));
    await tick(50);
    expect(drain(fd).every((b) => b === 0xaa)).toBe(true);

    const t0 = Date.now();
    const b = runWriter(dir);
    const bExit = exitOf(b);
    // The predecessor is SIGTERMed by the successor and goes without playing
    // its 2.5 s silence tail — which would otherwise interleave zeros into
    // the very frames the new link is feeding.
    expect(await aExit).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    // ...and without restoring the idle symlink either: the successor owns it.
    expect(await fs.readlink(dev)).toBe(fifo);
    expect(await waitPid(pidfile, b.pid)).toBe(String(b.pid));
    drain(fd);                                   // anything still in flight

    b.stdin.write(Buffer.alloc(8000, 0xbb));
    await tick(80);
    const heard = drain(fd);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((x) => x === 0xbb)).toBe(true);   // no zeros from A's tail
    b.stdin.end();
    fsSync.closeSync(fd); fd = -1;
    expect(await bExit).toBe(0);
    // B's feeder now holds the device; stopping it parks the device.
    expect(await fs.readlink(dev)).toBe(fifo);
    await stopFeeder(pidfile);
    expect(await fs.readlink(dev)).toBe(absent);
  } finally {
    if (fd >= 0) fsSync.closeSync(fd);
    try { a.kill('SIGKILL'); } catch {}
  }
}, 30000);

test.skipIf(!hasPython)('a stale pidfile (the pid is gone) is tolerated: the writer starts normally', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  // A pid that certainly no longer exists — a child we already reaped. This
  // is the SIGKILL-without-cleanup case: the pidfile and the symlink both
  // survive the dead writer, and the next one has to repair them.
  const corpse = spawn('/bin/sh', ['-c', 'exit 0']);
  const dead = corpse.pid;
  await exitOf(corpse);
  await fs.writeFile(pidfile, `${dead}\n`);
  await fs.unlink(dev);
  await fs.symlink(fifo, dev);      // left pointing at the FIFO, as a kill would

  const child = runWriter(dir);
  const exited = exitOf(child);
  let fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    expect(await waitPid(pidfile, child.pid)).toBe(String(child.pid));
    child.stdin.write(Buffer.alloc(8000, 0x7f));
    await tick(80);
    expect(drain(fd).every((b) => b === 0x7f)).toBe(true);
    child.stdin.end();
    fsSync.closeSync(fd); fd = -1;
    expect(await exited).toBe(0);
    expect(await fs.readlink(dev)).toBe(fifo);
    await stopFeeder(pidfile);
    expect(await fs.readlink(dev)).toBe(absent);
  } finally {
    if (fd >= 0) fsSync.closeSync(fd);
  }
}, 20000);

test.skipIf(!hasPython)('keeps S16 alignment across odd-length chunks and drops, then tails 2.5 s of zeros', async () => {
  const dir = await home();
  const { fifo, pidfile } = await fifoIn(dir);
  const child = runWriter(dir);
  const exited = exitOf(child);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  // A 16-bit ramp: every sample the reader sees must be a ramp value.
  const N = 20000;
  const ramp = Buffer.alloc(N * 2);
  for (let i = 0; i < N; i++) ramp.writeInt16LE(i % 32768, i * 2);
  const sizes = [1, 3, 7, 4095, 5, 4093, 2, 9];
  let pos = 0, k = 0;
  const got = [];
  while (pos < ramp.length) {
    const n = sizes[k++ % sizes.length];
    child.stdin.write(ramp.subarray(pos, pos + n)); pos += n;
    await new Promise((r) => setTimeout(r, 2));
    got.push(drain(fd));
  }
  child.stdin.end();
  const t0 = Date.now();
  // Read the paced tail. The writer keeps feeding for as long as this reader
  // holds the FIFO, so this loop stops on its own once 2.5 s of zeros have
  // arrived, then lets go — and only then may the writer exit.
  let zeroBytes = 0;
  let tailMs = 0;
  while (zeroBytes < 640 * 125 && Date.now() - t0 < 8000) {
    let n = 0;
    const buf = Buffer.alloc(65536);
    try { n = fsSync.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code !== 'EAGAIN') throw e; await new Promise((r) => setTimeout(r, 10)); continue; }
    if (n === 0) break;
    const chunk = Buffer.from(buf.subarray(0, n));
    got.push(chunk);
    if (!chunk.some((x) => x !== 0)) zeroBytes += n;
    tailMs = Date.now() - t0;
  }
  fsSync.closeSync(fd);
  const t1 = Date.now();
  expect(await exited).toBe(0);
  expect(Date.now() - t1).toBeLessThan(2500);   // gone promptly once the reader let go
  const all = Buffer.concat(got);
  expect(all.length % 2).toBe(0);
  const vals = [];
  for (let i = 0; i < all.length; i += 2) vals.push(all.readInt16LE(i));
  // Strip the zero tail, then every step must be a forward ramp step (a
  // half-sample drift would scramble the values).
  let end = vals.length;
  while (end > 0 && vals[end - 1] === 0) end--;
  const zeros = vals.length - end;
  for (let i = 1; i < end; i++) expect(vals[i] - vals[i - 1]).toBeGreaterThanOrEqual(0);
  expect(zeros).toBeGreaterThanOrEqual(320 * 100);   // ≥ 2 s of the 2.5 s tail reached the reader
  expect(tailMs).toBeGreaterThan(2000);              // ...and it was PACED, not dumped
  expect(tailMs).toBeLessThan(5000);
  await stopFeeder(pidfile);
}, 30000);

// Two Claude sessions starting together each run ensure.sh: two writers start
// at once with no predecessor. Without the lock both could claim the pidfile
// and both would feed the FIFO, and the loser — never named anywhere — would
// interleave its zeros into every later link's live audio.
test.skipIf(!hasPython)('two writers started at once end with exactly one instance holding the device', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  const a = runWriter(dir);
  const b = runWriter(dir);
  const aExit = exitOf(a);
  const bExit = exitOf(b);
  await tick(1200);
  const pid = await readPid(pidfile);
  expect([a.pid, b.pid]).toContain(pid);
  const winner = pid === a.pid ? a : b;
  const loser = pid === a.pid ? b : a;
  const loserExit = pid === a.pid ? bExit : aExit;
  expect(alive(winner.pid)).toBe(true);
  expect(await loserExit).toBe(0);
  expect(await fs.readlink(dev)).toBe(fifo);
  // Only the winner's audio is heard.
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    drain(fd);
    winner.stdin.write(Buffer.alloc(8000, 0xdd));
    await tick(80);
    const heard = drain(fd);
    expect(heard.length).toBe(8000);
    expect(heard.every((x) => x === 0xdd)).toBe(true);
  } finally {
    fsSync.closeSync(fd);
  }
  winner.stdin.end();
  expect(await (pid === a.pid ? aExit : bExit)).toBe(0);
  await stopFeeder(pidfile);
  expect(await fs.readlink(dev)).toBe(absent);
}, 20000);

// A reader mid-recording must never see EOF: on EOF alsa-lib's file plugin
// stops blocking and hands the reader stale "audio" at CPU speed. So the
// successor opens the FIFO before its predecessor is told to go...
test.skipIf(!hasPython)('a reader holding the FIFO across a takeover never sees EOF', async () => {
  const dir = await home();
  const { fifo, pidfile } = await fifoIn(dir);
  const a = runWriter(dir);
  const aExit = exitOf(a);
  a.stdin.end();
  expect(await aExit).toBe(0);                        // a feeder now holds the FIFO
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  let eof = 0;
  try {
    const b = runWriter(dir);
    const bExit = exitOf(b);
    const t0 = Date.now();
    while (Date.now() - t0 < 800) {
      const buf = Buffer.alloc(65536);
      try { if (fsSync.readSync(fd, buf, 0, buf.length, null) === 0) eof++; } catch (e) { if (e.code !== 'EAGAIN') throw e; }
      await tick(1);
    }
    expect(await waitPid(pidfile, b.pid)).toBe(String(b.pid));
    b.stdin.end();
    expect(await bExit).toBe(0);
  } finally {
    fsSync.closeSync(fd);
  }
  expect(eof).toBe(0);
  await stopFeeder(pidfile);
}, 20000);

// ...and a shutdown with a reader still attached parks the device (new opens
// fail rather than block) but keeps pacing silence until the reader lets go.
test.skipIf(!hasPython)('shutdown while a reader holds the FIFO: parked at once, silence until the reader lets go', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  const a = runWriter(dir);
  const aExit = exitOf(a);
  a.stdin.end();
  expect(await aExit).toBe(0);
  const feeder = await readPid(pidfile);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    drain(fd);
    process.kill(feeder, 'SIGTERM');
    await tick(300);
    expect(await fs.readlink(dev)).toBe(absent);   // parked at once
    expect(alive(feeder)).toBe(true);              // ...but still feeding this reader
    drain(fd);
    await tick(600);
    const got = drain(fd);
    expect(got.length).toBeGreaterThanOrEqual(8000);   // at least one chunk since the drain
    expect(got.every((x) => x === 0)).toBe(true);
  } finally {
    fsSync.closeSync(fd);
  }
  expect(await waitDead(feeder, 2000)).toBe(true);  // gone once the reader let go
  await expect(fs.access(pidfile)).rejects.toBeTruthy();
}, 20000);

// The native Claude Code path reads 48 kHz float32 mono in 19200-byte reads,
// and the link carries 16 kHz S16_LE: the writer converts on the box.
test.skipIf(!hasPython)('f32le48k mode: samples are held x3 as float32 in [-1, 1), in read-sized pieces, flushed after one piece-time', async () => {
  const dir = await home();
  const { fifo, pidfile } = await fifoIn(dir, 'f32le48k');
  const child = runWriter(dir);
  const exited = exitOf(child);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    const ramp = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) ramp.writeInt16LE(i - 160, i * 2);   // negatives too
    const piece = Math.min(19200, pipeCap(fifo));   // the reader's 100 ms read, or what the pipe holds
    child.stdin.write(ramp);
    await tick(15);
    expect(drain(fd).length).toBe(0);           // a partial piece is held...
    await tick(200);
    const got = drain(fd);
    expect(got.length).toBe(piece);             // ...then flushed padded after one piece-time
    for (let i = 0; i < 320; i++) {
      const v = (i - 160) / 32768;
      for (let k = 0; k < 3; k++) expect(got.readFloatLE((i * 3 + k) * 4)).toBeCloseTo(v, 9);
    }
    expect(got.subarray(3840).every((x) => x === 0)).toBe(true);
    // Five frames are 19200 bytes: whole pieces go out the moment they
    // complete, a remainder after one piece-time, all of it padded to pieces.
    child.stdin.write(Buffer.concat([ramp, ramp, ramp, ramp, ramp]));
    let total = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 400) { total += drain(fd).length; await tick(2); }   // a reader, as Claude would be
    expect(total).toBe(Math.ceil(19200 / piece) * piece);
  } finally {
    fsSync.closeSync(fd);
  }
  child.stdin.end();
  expect(await exited).toBe(0);
  await stopFeeder(pidfile);
}, 20000);

test.skipIf(!hasPython)('without a format file the mode follows /proc/asound/cards, as Claude Code does', async () => {
  const dir = await home();
  const { fifo, pidfile } = await fifoIn(dir, null);
  let cards = '';
  try { cards = await fs.readFile('/proc/asound/cards', 'utf8'); } catch {}
  const native = /^\s*\d/m.test(cards);
  const child = runWriter(dir);
  const exited = exitOf(child);
  child.stdin.end();
  expect(await exited).toBe(0);
  const piece = native ? Math.min(19200, pipeCap(fifo)) : 4000;
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    drain(fd);
    await tick(native ? 150 : 300);
    const got = drain(fd);
    expect(got.length % piece).toBe(0);
    expect(got.length).toBeGreaterThan(0);
  } finally {
    fsSync.closeSync(fd);
  }
  await stopFeeder(pidfile);
}, 20000);

// Under the rate recipe (a pipe that cannot be trusted to hold a 19200-byte
// read) the writer hands alsa-lib's rate plugin one 640-byte frame per write:
// bigger pieces are the ones that plugin silently loses (measured).
test.skipIf(!hasPython)('s16le-rate mode: one 640-byte frame per write, flushed after 20 ms', async () => {
  const dir = await home();
  const { fifo, dev, pidfile } = await fifoIn(dir, 's16le-rate');
  const child = runWriter(dir);
  const exited = exitOf(child);
  expect(await waitLink(dev, fifo)).toBe(true);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    child.stdin.write(Buffer.alloc(1000, 0x55));
    await tick(12);
    expect(drain(fd).length).toBe(640);        // one whole frame at once...
    await tick(60);
    const rest = drain(fd);
    expect(rest.length).toBe(640);             // ...the 360-byte remainder padded after 20 ms
    expect(rest.subarray(0, 360).every((x) => x === 0x55)).toBe(true);
    expect(rest.subarray(360).every((x) => x === 0)).toBe(true);
  } finally {
    fsSync.closeSync(fd);
  }
  child.stdin.end();
  expect(await exited).toBe(0);
  await stopFeeder(pidfile);
}, 20000);

// The crash this guards against: capture from alsa-lib's file plugin spins at
// CPU speed on any source that never blocks (/dev/zero, EOF) and blocks
// forever on a FIFO nobody feeds. The resident feeder is the only state that
// is neither: paced silence for a reader, and a blocked write — zero CPU —
// when there is none.
test.skipIf(!hasPython)('the feeder blocks with zero CPU while nobody reads, and paces silence for a reader', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  const child = runWriter(dir);
  const exited = exitOf(child);
  child.stdin.end();
  expect(await exited).toBe(0);
  const feeder = await readPid(pidfile);
  expect(alive(feeder)).toBe(true);
  // Nobody reads: the 4 KB pipe fills, the feeder's write blocks, and it burns
  // nothing — a process spinning would show tens of ticks over 1.5 s.
  const before = await cpuTicks(feeder);
  await tick(1500);
  expect((await cpuTicks(feeder)) - before).toBeLessThanOrEqual(2);
  expect(alive(feeder)).toBe(true);
  // A reader appears: it gets real-time silence, about 32 KB/s, not a flood.
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  drain(fd);
  const t0 = Date.now();
  let bytes = 0;
  while (Date.now() - t0 < 1000) { const got = drain(fd); bytes += got.length; expect(got.every((x) => x === 0)).toBe(true); await tick(20); }
  fsSync.closeSync(fd);
  expect(bytes).toBeGreaterThan(20000);
  expect(bytes).toBeLessThan(45000);
  expect(await fs.readlink(dev)).toBe(fifo);
  await stopFeeder(pidfile);
  expect(await fs.readlink(dev)).toBe(absent);
}, 20000);

test.skipIf(!hasPython)('a new link takes the feeder over: the feeder leaves at once and only the new audio is heard', async () => {
  const dir = await home();
  const { fifo, dev, absent, pidfile } = await fifoIn(dir);
  const a = runWriter(dir);
  const aExit = exitOf(a);
  a.stdin.end();
  expect(await aExit).toBe(0);
  const feeder = await readPid(pidfile);
  expect(alive(feeder)).toBe(true);
  const b = runWriter(dir);
  const bExit = exitOf(b);
  expect(await waitDead(feeder, 1500)).toBe(true);
  expect(await waitPid(pidfile, b.pid)).toBe(String(b.pid));
  expect(await fs.readlink(dev)).toBe(fifo);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  try {
    drain(fd);
    b.stdin.write(Buffer.alloc(8000, 0xcc));
    await tick(80);
    const heard = drain(fd);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((x) => x === 0xcc)).toBe(true);   // no zeros from the feeder
  } finally {
    fsSync.closeSync(fd);
  }
  b.stdin.end();
  expect(await bExit).toBe(0);
  await stopFeeder(pidfile);
  expect(await fs.readlink(dev)).toBe(absent);
}, 20000);
