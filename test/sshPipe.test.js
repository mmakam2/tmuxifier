import { test, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sshPipe } from '../src/server/sshRun.js';

test('sshPipe streams stdin chunks to the child and resolves its exit code on close', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshpipe-'));
  const out = path.join(dir, 'out');
  const h = sshPipe(['-c', 'cat > "$1"; exit 7', 'sh', out], { cmd: '/bin/sh' });
  h.stdin.write(Buffer.from('abc'));
  await new Promise((r) => setTimeout(r, 50));
  h.stdin.write(Buffer.from('def'));
  h.stdin.end();
  const res = await h.done;
  expect(res.code).toBe(7);
  expect(await fs.readFile(out, 'utf8')).toBe('abcdef');
});

test('sshPipe captures stderr and kill() settles done with a non-zero code', async () => {
  const h = sshPipe(['-c', 'echo oops >&2; cat > /dev/null'], { cmd: '/bin/sh' });
  await new Promise((r) => setTimeout(r, 100));
  h.kill();
  const res = await h.done;
  expect(res.code).not.toBe(0);
  expect(res.stderr).toContain('oops');
});

test('sshPipe never throws when the child exits before stdin is consumed', async () => {
  const h = sshPipe(['-c', 'exit 3'], { cmd: '/bin/sh' });
  await h.done;
  expect(() => { h.stdin.write(Buffer.alloc(4096)); h.stdin.end(); }).not.toThrow();
});
