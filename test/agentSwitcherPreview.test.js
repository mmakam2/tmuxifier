import { test, expect } from 'vitest';
import { createPreviewScheduler, PREVIEW_REST_MS, PREVIEW_CACHE_MS } from '../src/web/agentSwitcherPreview.ts';

function rig() {
  let t = 1000;
  const timers = [];
  const fetches = [];
  const r = {
    changes: 0,
    fetches,
    timers,
    now: () => t,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => !x.cleared && !x.fired && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at; due.fired = true; due.fn();
      }
      t = end;
    },
  };
  r.deps = {
    fetch(target, signal) {
      const rec = { target, signal, settled: false };
      rec.promise = new Promise((res, rej) => { rec.resolve = (v) => { rec.settled = true; res(v); }; rec.reject = (e) => { rec.settled = true; rej(e); }; });
      fetches.push(rec);
      return rec.promise;
    },
    now: () => t,
    setTimer(fn, ms) { const h = { fn, at: t + ms, cleared: false, fired: false }; timers.push(h); return h; },
    clearTimer(h) { h.cleared = true; },
    onChange() { r.changes += 1; },
  };
  r.s = createPreviewScheduler(r.deps);
  return r;
}
const A = { boxId: 'b1', session: 'a' };
const B = { boxId: 'b1', session: 'b' };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const abortErr = () => new DOMException('aborted', 'AbortError');

test('constants', () => {
  expect(PREVIEW_REST_MS).toBe(250);
  expect(PREVIEW_CACHE_MS).toBe(5000);
});

test('no fetch while tapping: five highlights 100 ms apart fire nothing', () => {
  const r = rig();
  for (let i = 0; i < 5; i++) { r.s.highlight({ boxId: 'b1', session: `s${i}` }); r.advance(100); }
  expect(r.fetches.length).toBe(0);
  expect(r.s.view()).toEqual({ t: 'loading' });
});

test('resting 250 ms fires exactly one fetch for the last highlight', () => {
  const r = rig();
  r.s.highlight(A); r.advance(100); r.s.highlight(B);
  r.advance(249);
  expect(r.fetches.length).toBe(0);
  r.advance(1);
  expect(r.fetches.length).toBe(1);
  expect(r.fetches[0].target).toEqual(B);
});

test('the text shows when it arrives', async () => {
  const r = rig();
  r.s.highlight(A);
  const before = r.changes;
  expect(before).toBeGreaterThan(0);
  r.advance(250);
  r.fetches[0].resolve('hello');
  await tick();
  expect(r.s.view()).toEqual({ t: 'text', text: 'hello' });
  expect(r.changes).toBeGreaterThan(before);
});

test('a newer highlight aborts the request in flight', () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  expect(r.fetches[0].signal.aborted).toBe(false);
  r.s.highlight(B);
  expect(r.fetches[0].signal.aborted).toBe(true);
});

test('a result that arrives after the highlight moved is cached, not shown', async () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  r.s.highlight(B);
  r.fetches[0].resolve('late');
  await tick();
  expect(r.s.view()).toEqual({ t: 'loading' });
  r.s.highlight(A);
  expect(r.s.view()).toEqual({ t: 'text', text: 'late' });
  r.advance(1000);
  expect(r.fetches.filter((f) => f.target.session === 'a').length).toBe(1);
});

test('the cache expires after 5 s', async () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  r.fetches[0].resolve('one');
  await tick();
  r.s.highlight(null);
  r.advance(5001);
  r.s.highlight(A);
  expect(r.s.view()).toEqual({ t: 'loading' });
  r.advance(250);
  expect(r.fetches.length).toBe(2);
});

test('a fresh cache entry shows at once with no timer and no fetch', async () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  r.fetches[0].resolve('one'); await tick();
  r.s.highlight(B); r.s.highlight(A);
  const live = r.timers.filter((x) => !x.cleared && !x.fired);
  expect(live.length).toBe(0);
  expect(r.s.view()).toEqual({ t: 'text', text: 'one' });
});

test('a failure shows error and is retried on the next rest', async () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  r.fetches[0].reject(new Error('boom'));
  await tick();
  expect(r.s.view()).toEqual({ t: 'error' });
  r.s.highlight(B); r.s.highlight(A);
  expect(r.s.view()).toEqual({ t: 'loading' });
  r.advance(250);
  expect(r.fetches.length).toBe(2);
  expect(r.fetches[1].target).toEqual(A);
});

test('an abort rejection is not an error', async () => {
  const r = rig();
  const seen = [];
  r.deps.onChange = () => seen.push(r.s.view().t);
  r.s.highlight(A); r.advance(250);
  r.s.highlight(B);
  r.fetches[0].reject(abortErr());
  await tick();
  expect(r.s.view().t).not.toBe('error');
  expect(seen).not.toContain('error');
});

test('highlight(null) goes idle and aborts', () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  r.s.highlight(null);
  expect(r.fetches[0].signal.aborted).toBe(true);
  expect(r.s.view()).toEqual({ t: 'idle' });
});

test('highlighting the same target again is a no-op', () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  r.s.highlight({ ...A });
  expect(r.fetches[0].signal.aborted).toBe(false);
  expect(r.fetches.length).toBe(1);
});

test('dispose cancels the timer and the request', () => {
  const r = rig();
  r.s.highlight(A); r.advance(250);
  r.s.highlight(B);
  r.s.dispose();
  r.advance(1000);
  expect(r.fetches.length).toBe(1);
  expect(r.fetches[0].signal.aborted).toBe(true);
  const r2 = rig();
  r2.s.highlight(A);
  r2.s.dispose();
  r2.advance(1000);
  expect(r2.fetches.length).toBe(0);
});

test('never two live requests at once', async () => {
  const r = rig();
  const live = () => r.fetches.filter((f) => !f.settled && !f.signal.aborted).length;
  const seq = [A, B, A, B, null, A];
  for (const t of seq) {
    r.s.highlight(t); expect(live()).toBeLessThanOrEqual(1);
    r.advance(260); expect(live()).toBeLessThanOrEqual(1);
  }
  r.fetches.forEach((f) => f.resolve('x'));
  await tick();
  expect(live()).toBe(0);
});
