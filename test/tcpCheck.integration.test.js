import { test, expect, afterEach } from 'vitest';
import net from 'node:net';
import { runTcpCheck } from '../src/server/checks/tcpCheck.js';

let server = null;
afterEach(async () => { if (server) { await new Promise((r) => server.close(r)); server = null; } });

const check = (host, port, over = {}) => ({ type: 'tcp', target: { host, port }, timeoutMs: 1500, ...over });

test('a listening port passes', async () => {
  server = net.createServer((s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const got = await runTcpCheck(check('127.0.0.1', server.address().port));
  expect(got.ok).toBe(true);
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a closed port fails with a readable detail', async () => {
  const got = await runTcpCheck(check('127.0.0.1', 1));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});

test('an unroutable address fails on the timeout rather than hanging', async () => {
  const got = await runTcpCheck(check('192.0.2.1', 9, { timeoutMs: 800 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/timed out|EHOSTUNREACH|ENETUNREACH|ECONN/i);
});

// The slice's executor contract: an executor never throws, because a throw
// takes down the runner's whole cycle — every other check in that cycle goes
// unrun. data/checks.json is a mutable file on disk and checkTypes.js does not
// re-validate a stored definition on read, so a malformed target is reachable
// in practice, not merely theoretical. net.connect also throws synchronously
// (ERR_SOCKET_BAD_PORT) on a missing or out-of-range port, which is why every
// dereference of `check` has to sit inside the executor's own guard rather than
// above it.
test('a check with no target fails rather than rejecting', async () => {
  const got = await runTcpCheck({ type: 'tcp', timeoutMs: 500 });
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a nonsense port fails rather than rejecting', async () => {
  const got = await runTcpCheck(check('127.0.0.1', 'not-a-port', { timeoutMs: 500 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});

test('a missing check object fails rather than throwing', async () => {
  const got = await runTcpCheck(undefined);
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});
