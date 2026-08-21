import { test, expect } from 'vitest';
import { createFreshProbe } from '../src/web/freshProbe.ts';

// The pane header's dropdown is reached for with the pointer, so its refresh
// fires on hover AND on the click that follows — and a user worrying it open
// and shut would otherwise spend one SSH round trip per pointer event. This is
// the policy that keeps that to one: single-flight per box, a short freshness
// window, and a cap on how long a caller will wait for an answer.

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness({ freshMs = 2000 } = {}) {
  let clock = 1000;
  const calls = [];
  const pending = [];
  const probe = (id) => {
    calls.push(id);
    const d = deferred();
    pending.push(d);
    return d.promise;
  };
  const fp = createFreshProbe({ probe, now: () => clock, freshMs });
  return { fp, calls, pending, tick: (ms) => { clock += ms; }, at: () => clock };
}

test('refresh probes the box and resolves once the probe lands', async () => {
  const h = harness();
  let done = false;
  const p = h.fp.refresh('b1').then(() => { done = true; });
  expect(h.calls).toEqual(['b1']);
  expect(done).toBe(false);
  h.pending[0].resolve();
  await p;
  expect(done).toBe(true);
});

// Two pointer events for one gesture (enter, then down) must not mean two
// probes: the second joins the first rather than queueing behind it.
test('concurrent refreshes of one box share a single probe', async () => {
  const h = harness();
  const a = h.fp.refresh('b1');
  const b = h.fp.refresh('b1');
  expect(h.calls).toEqual(['b1']);
  h.pending[0].resolve();
  await Promise.all([a, b]);
  expect(h.calls).toEqual(['b1']);
});

test('a refresh within the freshness window is a no-op', async () => {
  const h = harness({ freshMs: 2000 });
  const a = h.fp.refresh('b1');
  h.pending[0].resolve();
  await a;
  h.tick(1999);
  await h.fp.refresh('b1');
  expect(h.calls).toEqual(['b1']);
});

test('a refresh after the freshness window probes again', async () => {
  const h = harness({ freshMs: 2000 });
  const a = h.fp.refresh('b1');
  h.pending[0].resolve();
  await a;
  h.tick(2001);
  const b = h.fp.refresh('b1');
  expect(h.calls).toEqual(['b1', 'b1']);
  h.pending[1].resolve();
  await b;
});

// A box that cannot be probed (unreachable, mid-restart) must not leave the
// caller hanging, and must not be recorded as fresh — the next reach for the
// dropdown should try again rather than trusting a probe that never landed.
test('a failed probe resolves the caller and is not recorded as fresh', async () => {
  const h = harness();
  const a = h.fp.refresh('b1');
  h.pending[0].reject(new Error('unreachable'));
  await expect(a).resolves.toBeUndefined();
  const b = h.fp.refresh('b1');
  expect(h.calls).toEqual(['b1', 'b1']);
  h.pending[1].resolve();
  await b;
});

test('boxes are tracked independently', async () => {
  const h = harness();
  const a = h.fp.refresh('b1');
  const b = h.fp.refresh('b2');
  expect(h.calls).toEqual(['b1', 'b2']);
  h.pending[0].resolve();
  h.pending[1].resolve();
  await Promise.all([a, b]);
});

// The click path holds the native picker shut until this resolves, so a box
// that takes six seconds to answer must not mean a six-second dead click. The
// probe itself keeps running; the caller simply stops waiting for it.
test('waitMs caps how long a caller waits, without cancelling the probe', async () => {
  const h = harness();
  let capped = false;
  const p = h.fp.refresh('b1', { waitMs: 5 }).then(() => { capped = true; });
  expect(capped).toBe(false);
  await p;
  expect(capped).toBe(true);
  expect(h.calls).toEqual(['b1']);
  // The abandoned probe still lands, and still counts as fresh afterwards.
  h.pending[0].resolve();
  await Promise.resolve();
  await Promise.resolve();
  await h.fp.refresh('b1');
  expect(h.calls).toEqual(['b1']);
});
