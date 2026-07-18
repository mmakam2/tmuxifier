import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sshRunStdin, sshStream } from '../src/server/sshRun.js';

// cmd override lets these tests exercise the spawn/stdin/timeout mechanics with
// /bin/sh instead of a real ssh connection (the ssh path is covered by
// upload.integration.test.js).

test('pipes the input buffer to stdin and captures stdout + exit code', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-sshrun-'));
  const dest = path.join(dir, 'out.bin');
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]); // binary-safe
  const res = await sshRunStdin(['-c', `cat > '${dest}' && echo done`], payload, { cmd: '/bin/sh' });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('done');
  expect(await fs.readFile(dest)).toEqual(payload);
  await fs.rm(dir, { recursive: true, force: true });
});

test('reports a non-zero exit code and stderr', async () => {
  const res = await sshRunStdin(['-c', 'echo bad >&2; exit 7'], '', { cmd: '/bin/sh' });
  expect(res.code).toBe(7);
  expect(res.stderr).toContain('bad');
});

test('survives the child exiting before stdin is written (EPIPE)', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 0x41);
  const res = await sshRunStdin(['-c', 'exit 3'], big, { cmd: '/bin/sh' });
  expect(res.code).toBe(3);
});

test('kills the child and resolves code 124 on timeout', async () => {
  const res = await sshRunStdin(['-c', 'sleep 30'], '', { cmd: '/bin/sh', timeout: 300 });
  expect(res.code).toBe(124);
});

test('sshStream streams stdout/stderr chunks and resolves the exit code', async () => {
  const chunks = [];
  const { done } = sshStream(['-c', 'echo hello; echo boom >&2; exit 0'], {
    cmd: '/bin/sh', onData: (c, s) => chunks.push([s, c]),
  });
  const { code } = await done;
  expect(code).toBe(0);
  const out = chunks.filter(([s]) => s === 'stdout').map(([, c]) => c).join('');
  const err = chunks.filter(([s]) => s === 'stderr').map(([, c]) => c).join('');
  expect(out).toContain('hello');
  expect(err).toContain('boom');
});

test('sshStream reports a non-zero exit code', async () => {
  const { done } = sshStream(['-c', 'exit 7'], { cmd: '/bin/sh' });
  expect((await done).code).toBe(7);
});

test('sshStream kills the child and resolves 124 on timeout', async () => {
  const { done } = sshStream(['-c', 'sleep 30'], { cmd: '/bin/sh', timeout: 300 });
  expect((await done).code).toBe(124);
});

test('sshStream kill() terminates the child', async () => {
  const h = sshStream(['-c', 'sleep 30'], { cmd: '/bin/sh' });
  h.kill();
  expect((await h.done).code).not.toBe(0);
});

// A multi-byte UTF-8 character split across two pipe chunks must decode
// intact — per-chunk Buffer→string conversion turns the split glyph into
// replacement characters (installer progress bars hit this constantly).
test('decodes UTF-8 split across chunk boundaries without mojibake', async () => {
  // ✓ is U+2713 = e2 9c 93; flush mid-character to force a chunk split.
  const script = "printf '\\342\\234'; sleep 0.05; printf '\\223\\n'";
  const res = await sshRunStdin(['-c', script], '', { cmd: '/bin/sh', timeout: 10000 });
  expect(res.code).toBe(0);
  expect(res.stdout).toContain('✓');
  expect(res.stdout).not.toContain('�');
});

// A killed-by-timeout ssh must not read as "the remote command exited 1" —
// resolve 124 (the shell timeout convention sshRunStdin already uses).
test('sshRun resolves code 124 with timedOut set when killed by its timeout', async () => {
  const { sshRun } = await import('../src/server/sshRun.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmuxifier-sshrun-t-'));
  const shim = path.join(dir, 'ssh');
  await fs.writeFile(shim, '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  // Shim dir first so `ssh` resolves to it; system dirs kept so the shim's
  // own `sleep` still resolves.
  const res = await sshRun(['whatever'], { env: { PATH: `${dir}:/usr/bin:/bin` }, timeout: 200 });
  expect(res.code).toBe(124);
  expect(res.timedOut).toBe(true);
  await fs.rm(dir, { recursive: true, force: true });
});
