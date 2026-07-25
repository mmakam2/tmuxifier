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

test('a non-iterable assert.status (a bare number) falls back to the default range instead of throwing', async () => {
  // checkTypes.js only shallow-copies `assert`, so nothing upstream guarantees
  // `assert.status` is actually a [min, max] tuple by the time it reaches
  // here. Destructuring a non-iterable like a bare number throws — this
  // pins that the executor treats that the same as an absent assert.status
  // (falls back to the default range) rather than letting it escape and
  // crash the runner's cycle. The response here (500) is deliberately
  // outside the default range, so the assertion is meaningful: it would also
  // pass if the executor just returned ok:true unconditionally for anything
  // that didn't crash, which is not what we want to claim.
  const url = await serve((_req, res) => { res.writeHead(500); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: 200 } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('200-399');
});

// The throw above is the loud failure mode. The dangerous one is silent: a
// value that IS iterable but not actually a valid [min, max] pair doesn't
// throw at all, it just corrupts the comparison — turning a real outage into
// a false ok:true, which is the one failure class this whole system exists
// to prevent. Each case below picks a response status that only a correctly
// *rejecting* (fallback-to-default) implementation would fail on.
test('a truncated assert.status ([500], missing the upper bound) does not leave max undefined and wide open', async () => {
  // Bug this pins: `const [min, max] = [500]` leaves max === undefined, and
  // `res.status > undefined` is always false — so with the unvalidated
  // destructuring, ANY status >= 500 (not just >= 500 and <= some real
  // ceiling) would incorrectly pass.
  const url = await serve((_req, res) => { res.writeHead(599); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [500] } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('200-399');
});

test('an empty assert.status ([]) does not leave both bounds undefined and let everything pass', async () => {
  // Bug this pins: `const [min, max] = []` leaves both undefined, so neither
  // `res.status < undefined` nor `res.status > undefined` is ever true —
  // every status, including a plain 500, would incorrectly pass.
  const url = await serve((_req, res) => { res.writeHead(500); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [] } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('200-399');
});

test('a string assert.status does not get destructured character-by-character', async () => {
  // Bug this pins: a string is iterable, so `const [min, max] = '200-400'`
  // silently succeeds with min='2', max='0' — producing a nonsensical
  // "expected 2-0" detail instead of either honoring intent or falling back
  // cleanly to the real default range.
  const url = await serve((_req, res) => { res.writeHead(500); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: '200-400' } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('200-399');
  expect(got.detail).not.toContain('2-0');
});

test('an assert.status with extra trailing elements is rejected rather than using just its first two', async () => {
  // Number.isFinite on the first two elements alone can't distinguish a
  // well-formed 2-tuple from a longer array that merely happens to start
  // with two finite numbers ([500] and [] are both already caught by the
  // isFinite checks regardless of length) — this is what specifically
  // requires the exact status.length === 2 check.
  const url = await serve((_req, res) => { res.writeHead(500); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [200, 300, 'note'] } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('200-399');
});

test('a typed array (iterable, has .length, but Array.isArray is false) is not treated as a valid custom range', async () => {
  // Number.isFinite + length alone can't tell a real array apart from any
  // other iterable that happens to have a numeric .length and finite values
  // at [0]/[1] — a typed array is exactly such a case. If Array.isArray were
  // dropped, this range (500-600) would be accepted as-is and a 500 response
  // would wrongly pass; the correct behavior is to reject it as malformed
  // and fall back to the real default (200-399), under which 500 fails.
  const url = await serve((_req, res) => { res.writeHead(500); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: new Float64Array([500, 600]) } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('200-399');
});

test('an assert.status with a non-numeric bound falls back to the default range', async () => {
  // Same root cause, one element short of the [500] case: length is right
  // but a bound isn't actually a number, so a bare Array.isArray + length
  // check alone would not be enough — this is what pins Number.isFinite.
  const url = await serve((_req, res) => { res.writeHead(500); res.end(); });
  const got = await runHttpCheck(check(url, { assert: { status: [200, 'x'] } }));
  expect(got.ok).toBe(false);
  expect(got.detail).toContain('200-399');
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
