import { test, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildVoiceWriterRemote, WRITER_PROGRAM, WRITER_EXIT_NOT_SET_UP, VOICE_FIFO_REL } from '../src/server/voiceWriter.js';

const hasPython = (() => { try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// Runs the remote command the way the box's login shell would, with HOME
// pointed at a temp dir. Returns the child so tests can stream stdin.
function runWriter(home) {
  return spawn('/bin/sh', ['-c', buildVoiceWriterRemote()], { env: { PATH: process.env.PATH, HOME: home }, stdio: ['pipe', 'ignore', 'pipe'] });
}
const exitOf = (child) => new Promise((r) => child.on('close', (c) => r(c)));
async function home() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-'));
  return dir;
}
async function fifoIn(dir) {
  const d = path.join(dir, '.tmuxifier-voice');
  await fs.mkdir(d, { recursive: true, mode: 0o700 });
  const f = path.join(d, 'mic');
  execFileSync('mkfifo', ['-m', '600', f]);
  return f;
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
  expect(remote).toContain(`"$HOME/${VOICE_FIFO_REL}"`);
  expect(remote.match(/\$\{?[A-Za-z_]\w*\}?/g)).toEqual(['$HOME', '$HOME']);
  expect(WRITER_EXIT_NOT_SET_UP).toBe(3);
});

test('exits 3 at once when the FIFO does not exist', async () => {
  const dir = await home();
  const child = runWriter(dir);
  child.stdin.end(Buffer.alloc(100));
  const t0 = Date.now();
  expect(await exitOf(child)).toBe(3);
  expect(Date.now() - t0).toBeLessThan(2000);
});

test('cat fallback: exits 3 when FIFO missing and python3 not on PATH', async () => {
  const dir = await home();
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-bin-'));
  try {
    const catPath = execFileSync('command', ['-v', 'cat'], { shell: true, encoding: 'utf-8' }).trim();
    const catLink = path.join(binDir, 'cat');
    await fs.symlink(catPath, catLink);
    const child = spawn('/bin/sh', ['-c', buildVoiceWriterRemote()], { env: { PATH: binDir, HOME: dir }, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stdin.destroy();
    const t0 = Date.now();
    expect(await exitOf(child)).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2000);
  } finally {
    try { await fs.rm(binDir, { recursive: true, force: true }); } catch {}
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }
});

test.skipIf(!hasPython)('never blocks without a reader, keeps at most 4 KB, and exits 0 after stdin ends', async () => {
  const dir = await home();
  const fifo = await fifoIn(dir);
  const child = runWriter(dir);
  const exited = exitOf(child);
  child.stdin.end(Buffer.from(Array.from({ length: 100 * 1024 }, (_, i) => i & 0xff)));
  const t0 = Date.now();
  expect(await exited).toBe(0);
  // The 2.5 s silence tail is the only thing that takes time.
  expect(Date.now() - t0).toBeLessThan(5000);
  const fd = fsSync.openSync(fifo, fsSync.constants.O_RDONLY | fsSync.constants.O_NONBLOCK);
  const kept = drain(fd);
  fsSync.closeSync(fd);
  expect(kept.length).toBeLessThanOrEqual(4096);
  expect(kept.length % 2).toBe(0);
});

test.skipIf(!hasPython)('keeps S16 alignment across odd-length chunks and drops, then tails 2.5 s of zeros', async () => {
  const dir = await home();
  const fifo = await fifoIn(dir);
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
  // Read until EOF (the writer's tail, then its exit).
  for (;;) {
    let n = 0;
    const buf = Buffer.alloc(65536);
    try { n = fsSync.readSync(fd, buf, 0, buf.length, null); } catch (e) { if (e.code !== 'EAGAIN') throw e; await new Promise((r) => setTimeout(r, 10)); continue; }
    if (n === 0) break;
    got.push(Buffer.from(buf.subarray(0, n)));
  }
  const tailMs = Date.now() - t0;
  fsSync.closeSync(fd);
  expect(await exited).toBe(0);
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
  expect(tailMs).toBeGreaterThan(2000);
  expect(tailMs).toBeLessThan(4000);
}, 30000);
