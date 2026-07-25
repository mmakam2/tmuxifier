import { test, expect } from 'vitest';
import { runExecCheck } from '../src/server/checks/execCheck.js';

const deps = (result, boxes = [{ id: 'b1', host: '192.168.1.10' }]) => ({
  store: { listBoxes: async () => boxes },
  boxActions: { execCommand: async () => result },
  now: () => 0,
});
const check = (over = {}) => ({
  type: 'exec', target: { boxId: 'b1', command: 'systemctl is-active myservice' },
  assert: {}, timeoutMs: 5000, ...over,
});

test('exit code zero passes', async () => {
  expect((await runExecCheck(check(), deps({ code: 0, stdout: 'active\n', stderr: '' }))).ok).toBe(true);
});

test('a non-zero exit fails and the detail carries the code and stderr', async () => {
  const got = await runExecCheck(check(), deps({ code: 3, stdout: '', stderr: 'inactive' }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('3');
  expect(got.detail).toContain('inactive');
});

test('stdoutIncludes fails when the marker is absent even on exit zero', async () => {
  const got = await runExecCheck(
    check({ assert: { stdoutIncludes: 'active' } }),
    deps({ code: 0, stdout: 'failed\n', stderr: '' }),
  );
  expect(got.ok).toBe(false);
});

test('stdoutIncludes passes when the marker is present', async () => {
  const got = await runExecCheck(
    check({ assert: { stdoutIncludes: 'active' } }),
    deps({ code: 0, stdout: 'active\n', stderr: '' }),
  );
  expect(got.ok).toBe(true);
});

test('a box that no longer exists fails the check instead of throwing', async () => {
  const got = await runExecCheck(check(), deps({ code: 0, stdout: '', stderr: '' }, []));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/box/i);
});

test('an ssh-level failure is a check failure, not an exception', async () => {
  const got = await runExecCheck(check(), {
    store: { listBoxes: async () => [{ id: 'b1' }] },
    boxActions: { execCommand: async () => { throw new Error('ssh: connect timed out'); } },
    now: () => 0,
  });
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('ssh');
});

test('detail is truncated so one runaway command cannot bloat the event log', async () => {
  const got = await runExecCheck(check(), deps({ code: 1, stdout: 'x'.repeat(5000), stderr: '' }));
  expect(got.detail.length).toBeLessThanOrEqual(320);
});

// The slice's executor contract. Unlike the network executors, this one reaches
// two injected collaborators before it reaches the network, so it has two more
// ways to throw: the box lookup dereferences check.target, and listBoxes() does
// real disk I/O and can reject on a corrupt or unreadable boxes.json. Either
// one escaping would abort the runner's whole due cycle, taking every other
// check scheduled in it down too.
test('a check with no target fails rather than throwing', async () => {
  const got = await runExecCheck({ type: 'exec', timeoutMs: 500 }, deps({ code: 0, stdout: '', stderr: '' }));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});

test('a store read failure fails the check rather than throwing', async () => {
  const got = await runExecCheck(check(), {
    store: { listBoxes: async () => { throw new Error('boxes.json unreadable'); } },
    boxActions: { execCommand: async () => ({ code: 0, stdout: '', stderr: '' }) },
    now: () => 0,
  });
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/boxes\.json/);
});

test('a missing check object fails rather than throwing', async () => {
  const got = await runExecCheck(undefined, deps({ code: 0, stdout: '', stderr: '' }));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});
