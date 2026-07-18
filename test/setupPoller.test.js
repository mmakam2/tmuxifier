import { test, expect } from 'vitest';
import { createSetupJobPoller } from '../src/web/setupPoller.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness(onJob) {
  const fetches = [];
  const timers = [];
  const poller = createSetupJobPoller({
    fetchJob: () => { const d = deferred(); fetches.push(d); return d.promise; },
    onJob,
    schedule: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    cancel: (t) => { timers[t] = null; },
  });
  return { poller, fetches, timers, fire: () => { const t = timers.pop(); if (t) t.fn(); } };
}

test('the onJob policy drives the loop: its returned delay reschedules, null stops', async () => {
  const seen = [];
  const h = harness((job) => { seen.push(job); return job && job.status === 'running' ? 1500 : null; });
  h.poller.start();
  h.fetches[0].resolve({ status: 'running' });
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toEqual([{ status: 'running' }]);
  expect(h.timers.filter(Boolean)).toHaveLength(1);
  expect(h.timers[0].ms).toBe(1500);

  h.fire();
  h.fetches[1].resolve({ status: 'done' });
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toHaveLength(2);
  expect(h.timers.filter(Boolean)).toHaveLength(0); // null → no reschedule
});

test('a response landing after stop() is discarded', async () => {
  const seen = [];
  const h = harness((job) => { seen.push(job); return null; });
  h.poller.start();
  h.poller.stop();
  h.fetches[0].resolve({ status: 'done' });
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toEqual([]);
});

test('restarting supersedes the in-flight fetch of the previous run', async () => {
  const seen = [];
  const h = harness((job) => { seen.push(job); return null; });
  h.poller.start();            // fetch #0 in flight
  h.poller.start();            // supersedes — fetch #1
  h.fetches[1].resolve({ id: 'new' });
  h.fetches[0].resolve({ id: 'old' });
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toEqual([{ id: 'new' }]);
});

test('a rejected fetch reaches the policy as null (transient error handling stays in the caller)', async () => {
  const seen = [];
  const h = harness((job) => { seen.push(job); return null; });
  h.poller.start();
  h.fetches[0].reject(new Error('blip'));
  await new Promise((r) => setTimeout(r, 0));
  expect(seen).toEqual([null]);
});
