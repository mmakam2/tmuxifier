import { test, expect } from 'vitest';
import { createKnownHosts } from '../src/server/knownHosts.js';

function capture() {
  const calls = [];
  return { calls, run: async (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; } };
}

test('forget removes the plain host entry', async () => {
  const { calls, run } = capture();
  await createKnownHosts({ run }).forget('192.168.1.50', 22);
  expect(calls).toEqual([['-R', '192.168.1.50']]);
});

test('forget removes ONLY the bracketed form for a nonstandard port (the bare entry is the port-22 machine, possibly a different one)', async () => {
  const { calls, run } = capture();
  await createKnownHosts({ run }).forget('box.example.com', 2222);
  expect(calls).toEqual([['-R', '[box.example.com]:2222']]);
});

test('forget treats a missing port like 22 (plain form only)', async () => {
  const { calls, run } = capture();
  await createKnownHosts({ run }).forget('box.example.com', undefined);
  expect(calls).toEqual([['-R', 'box.example.com']]);
});

test('forget never throws when run fails or rejects', async () => {
  const boom = createKnownHosts({ run: async () => { throw new Error('no ssh-keygen'); } });
  const results = await boom.forget('h', 2222);
  expect(results).toHaveLength(1);
  expect(results[0].code).toBe(1);
  const failCode = createKnownHosts({ run: async () => ({ code: 255, stdout: '', stderr: 'nope' }) });
  await expect(failCode.forget('h', 22)).resolves.toEqual([{ code: 255, stdout: '', stderr: 'nope' }]);
});
