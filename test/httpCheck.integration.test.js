import { test, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import { runHttpCheck } from '../src/server/checks/httpCheck.js';

const servers = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop().close(r));
});

async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
const check = (url, over = {}) => ({ type: 'http', target: { url }, assert: {}, timeoutMs: 2000, ...over });

test('a 200 response passes', async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.end('ok'); });
  const got = await runHttpCheck(check(url));
  expect(got.ok).toBe(true);
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a 502 response fails and the detail names the status', async () => {
  const url = await serve((_req, res) => { res.writeHead(502); res.end('bad gateway'); });
  const got = await runHttpCheck(check(url));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('502');
  // Failure paths must carry a latency too, not just the success path.
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
});

test('a custom status range accepts what the default range would reject', async () => {
  const url = await serve((_req, res) => { res.writeHead(404); res.end(); });
  expect((await runHttpCheck(check(url, { assert: { status: [404, 404] } }))).ok).toBe(true);
});

test('bodyIncludes fails when the marker is absent', async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.end('degraded'); });
  const got = await runHttpCheck(check(url, { assert: { bodyIncludes: 'healthy' } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('healthy');
});

test('bodyIncludes passes when the marker is present', async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.end('all healthy here'); });
  expect((await runHttpCheck(check(url, { assert: { bodyIncludes: 'healthy' } }))).ok).toBe(true);
});

test('a hung server fails on the timeout rather than hanging the runner', async () => {
  const url = await serve(() => { /* never responds */ });
  const got = await runHttpCheck(check(url, { timeoutMs: 1000 }));
  expect(got.ok).toBe(false);
  // Deliberately narrow: the underlying AbortError's own message text is
  // "This operation was aborted", which already contains "abort" — so a
  // regex of /timed out|abort/i would pass even if our own AbortError
  // detection were disabled and the code fell through to the generic
  // e.message branch. Requiring "timed out" specifically pins that our
  // aborted-branch, not the runtime's incidental wording, produced this.
  expect(got.detail).toMatch(/timed out/i);
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
  // Pins that check.timeoutMs itself (1000ms here) drives the abort, not a
  // hardcoded fallback: a fallback-only implementation still resolves
  // ok:false eventually, just ~10s late, which the assertions above alone
  // would miss entirely.
  expect(got.latencyMs).toBeLessThan(5000);
});

test('a connection refused is a check failure, not a thrown error', async () => {
  const got = await runHttpCheck(check('http://127.0.0.1:1/health', { timeoutMs: 1000 }));
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
  expect(got.latencyMs).toBeGreaterThanOrEqual(0);
  // A refused connection is a distinct failure mode from a timeout; the two
  // must not be reported with the same wording (otherwise an operator can't
  // tell "nothing is listening" from "it's too slow to answer").
  expect(got.detail).not.toMatch(/timed out/i);
});

test('a fetchImpl that throws synchronously resolves to ok:false, never rejects', async () => {
  // Guards the try/catch actually wrapping the fetchImpl call site (not just
  // the await of an already-pending promise) — a call-site throw and a
  // rejected promise are different JS mechanics and both must be caught.
  const throwing = () => { throw new Error('boom'); };
  await expect(runHttpCheck(check('http://example.com/'), { fetchImpl: throwing }))
    .resolves.toMatchObject({ ok: false, detail: expect.stringContaining('boom') });
});

test('status exactly at the min of a custom range passes', async () => {
  const url = await serve((_req, res) => { res.writeHead(500); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [500, 504] } }));
  expect(got.ok).toBe(true);
});

test('status exactly at the max of a custom range passes', async () => {
  const url = await serve((_req, res) => { res.writeHead(504); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [500, 504] } }));
  expect(got.ok).toBe(true);
});

test('status one below the min of a custom range fails', async () => {
  const url = await serve((_req, res) => { res.writeHead(499); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [500, 504] } }));
  expect(got.ok).toBe(false);
});

test('status one above the max of a custom range fails', async () => {
  const url = await serve((_req, res) => { res.writeHead(505); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [500, 504] } }));
  expect(got.ok).toBe(false);
});

test('the default range accepts exactly 399, its inclusive upper bound', async () => {
  const url = await serve((_req, res) => { res.writeHead(399); res.end(); });
  const got = await runHttpCheck(check(url));
  expect(got.ok).toBe(true);
});

test('the default range rejects exactly 400, one past its inclusive upper bound', async () => {
  const url = await serve((_req, res) => { res.writeHead(400); res.end(); });
  const got = await runHttpCheck(check(url));
  expect(got.ok).toBe(false);
});

test('a check secret is sent as a bearer auth header', async () => {
  let gotAuth;
  const url = await serve((req, res) => { gotAuth = req.headers.authorization; res.writeHead(200); res.end(); });
  await runHttpCheck(check(url, { secret: 'tok123' }));
  expect(gotAuth).toBe('Bearer tok123');
});

test('no auth header is sent when the check has no secret', async () => {
  let gotAuth = 'unset';
  const url = await serve((req, res) => { gotAuth = req.headers.authorization; res.writeHead(200); res.end(); });
  await runHttpCheck(check(url));
  expect(gotAuth).toBeUndefined();
});

test('a redirect status is reported as-is rather than being silently followed', async () => {
  // Without redirect:'manual', fetch would transparently follow the 302 and
  // report the target's 200 — hiding the fact that the checked URL itself
  // is redirecting, which is exactly the kind of drift a check should surface.
  let targetHit = false;
  const target = await serve((_req, res) => { targetHit = true; res.writeHead(200); res.end(); });
  const url = await serve((_req, res) => { res.writeHead(302, { Location: target }); res.end(); });
  const got = await runHttpCheck(check(url));
  expect(got.detail).toContain('302');
  expect(targetHit).toBe(false);
});

test('the timeout timer is cleared on a successful response, not left to fire later', async () => {
  // An uncleared timer is invisible to every assertion above (it only ever
  // aborts a request that has already finished), so it needs its own probe.
  // A bare spy on clearTimeout is not enough — undici's own fetch internals
  // call clearTimeout too, so an unrelated call would make the assertion
  // pass vacuously even if the executor's own timer leaked. Instead, capture
  // the specific id the executor's setTimeout call returns (it runs
  // synchronously before the first await, so it's necessarily the first
  // timer created) and check clearTimeout was called with exactly that id.
  const url = await serve((_req, res) => { res.writeHead(200); res.end(); });
  const realSetTimeout = global.setTimeout;
  let capturedTimer;
  const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest);
    if (capturedTimer === undefined) capturedTimer = id;
    return id;
  });
  const clearSpy = vi.spyOn(global, 'clearTimeout');
  try {
    await runHttpCheck(check(url));
    expect(capturedTimer).toBeDefined();
    expect(clearSpy).toHaveBeenCalledWith(capturedTimer);
  } finally {
    setTimeoutSpy.mockRestore();
    clearSpy.mockRestore();
  }
});
