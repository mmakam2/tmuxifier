import { test, expect } from 'vitest';
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
  return dir;
}
// The box-side layout the install script (claudeVoiceLink.js) leaves behind:
// the real FIFO is mic.fifo, and `mic` — what ~/.asoundrc names — is a
// symlink parked on an ABSENT path, so an idle capture open fails cleanly.
// Not /dev/zero and not the FIFO: alsa-lib's null slave has no clock, so any
// source that never blocks (/dev/zero, or EOF) makes capture spin at CPU
// speed — measured at 331 million frames/s — and the reader buffers that
// "audio" until the box is out of memory. Only a live writer paces.
async function fifoIn(dir) {
  const d = path.join(dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  const fifo = path.join(d, 'mic.fifo');
  execFileSync('mkfifo', ['-m', '600', fifo]);
  const dev = path.join(d, 'mic');
  const absent = path.join(d, 'mic.absent');
  await fs.symlink(absent, dev);
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

test.skipIf(!hasPython)('never blocks without a reader, keeps at most 4 KB, and exits 0 after stdin ends', async () => {
  const dir = await home();
  const { fifo, dev, absent } = await fifoIn(dir);
  const child = runWriter(dir);
  const exited = exitOf(child);
  child.stdin.end(Buffer.from(Array.from({ length: 100 * 1024 }, (_, i) => i & 0xff)));
  const t0 = Date.now();
  expect(await exited).toBe(0);
  // The 2.5 s silence tail is the only thing that takes time.
  expect(Date.now() - t0).toBeLessThan(5000);
  // The idle device is absent again, so the next Claude Code press on this
  // box fails to open rather than blocking on a writerless FIFO or spinning
  // on a source that never blocks.
  expect(await fs.readlink(dev)).toBe(absent);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  const kept = drain(fd);
  fsSync.closeSync(fd);
  expect(kept.length).toBeLessThanOrEqual(4096);
  expect(kept.length % 2).toBe(0);
});

test.skipIf(!hasPython)('points the device at the FIFO while alive, records its pid, and restores both on exit', async () => {
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
    a.stdin.write(Buffer.alloc(640, 0xaa));
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

    b.stdin.write(Buffer.alloc(640, 0xbb));
    await tick(80);
    const heard = drain(fd);
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((x) => x === 0xbb)).toBe(true);   // no zeros from A's tail
    b.stdin.end();
    // A writer never leaves while a reader still holds the FIFO (see the
    // reader-hold test below), so the reader lets go before the exit.
    fsSync.closeSync(fd); fd = -1;
    expect(await bExit).toBe(0);
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
    child.stdin.write(Buffer.alloc(640, 0x7f));
    await tick(80);
    expect(drain(fd).every((b) => b === 0x7f)).toBe(true);
    child.stdin.end();
    fsSync.closeSync(fd); fd = -1;
    expect(await exited).toBe(0);
    expect(await fs.readlink(dev)).toBe(absent);
  } finally {
    if (fd >= 0) fsSync.closeSync(fd);
  }
}, 20000);

test.skipIf(!hasPython)('keeps S16 alignment across odd-length chunks and drops, then tails 2.5 s of zeros', async () => {
  const dir = await home();
  const { fifo } = await fifoIn(dir);
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
}, 30000);

// The crash this guards against: a reader (Claude Code mid-recording) that
// still holds the FIFO when the link ends. If the writer closed after its
// tail, the reader would see EOF, and alsa-lib's file plugin turns EOF into
// a stale-buffer spin at CPU speed — the reader then buffers that "audio"
// until the box, and then the host, is out of memory. So the writer keeps
// feeding paced silence for as long as any O_RDONLY holder remains, and only
// parks the device on the absent path once the last one has let go.
test.skipIf(!hasPython)('keeps feeding paced silence while a reader holds the FIFO, and leaves only after it lets go', async () => {
  const dir = await home();
  const { fifo, dev, absent } = await fifoIn(dir);
  const child = runWriter(dir);
  const exited = exitOf(child);
  expect(await waitLink(dev, fifo)).toBe(true);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  child.stdin.write(Buffer.alloc(640, 0x11));
  await tick(50);
  drain(fd);
  child.stdin.end();
  // Well past the 2.5 s tail: the writer must still be alive and still pacing
  // zeros at real time (32 KB/s) into a FIFO somebody is reading.
  await tick(3500);
  drain(fd);
  const t0 = Date.now();
  let bytes = 0;
  while (Date.now() - t0 < 1000) { bytes += drain(fd).length; await tick(20); }
  expect(bytes).toBeGreaterThan(20000);
  expect(bytes).toBeLessThan(45000);
  let settled = false;
  exited.then(() => { settled = true; });
  await tick(50);
  expect(settled).toBe(false);
  expect(await fs.readlink(dev)).toBe(fifo);
  // The reader lets go: the writer parks the device and exits promptly.
  fsSync.closeSync(fd);
  const t1 = Date.now();
  expect(await exited).toBe(0);
  expect(Date.now() - t1).toBeLessThan(2500);
  expect(await fs.readlink(dev)).toBe(absent);
}, 30000);
