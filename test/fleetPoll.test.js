import { test, expect } from 'vitest';
import { createFleetPoller } from '../src/web/fleetPoll.ts';

// Manual promise so tests control exactly when a fetch resolves — the stale
// -response races are the whole point.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function harness() {
  const fetches = []; // one deferred per fetchJob call, in call order
  const rendered = [];
  const errors = [];
  let finished = 0;
  const timers = []; // scheduled callbacks, run manually via fire()
  const poller = createFleetPoller({
    fetchJob: () => { const d = deferred(); fetches.push(d); return d.promise; },
    render: (job) => { rendered.push(job); return true; },
    renderError: () => { errors.push(1); },
    onFinished: () => { finished += 1; },
    schedule: (fn) => { timers.push(fn); return timers.length - 1; },
    cancel: (t) => { timers[t] = null; },
  });
  const fire = () => { const fn = timers.pop(); if (fn) fn(); };
  return { poller, fetches, rendered, errors, timers, fire, finishedCount: () => finished };
}

test('a running job renders and keeps polling; a finished poll response stops and refreshes history', async () => {
  const h = harness();
  const p = h.poller.show('A');
  h.fetches[0].resolve({ id: 'A', status: 'running' });
  await p;
  expect(h.rendered).toEqual([{ id: 'A', status: 'running' }]);
  expect(h.poller.watching()).toBe('A');

  h.fire(); // poll tick
  h.fetches[1].resolve({ id: 'A', status: 'done' });
  await new Promise((r) => setTimeout(r, 0));
  expect(h.rendered).toHaveLength(2);
  expect(h.finishedCount()).toBe(1);
  expect(h.poller.watching()).toBe(null);
});

test('a stale finished response for job A must not stop job B\'s polling (the switched-view race)', async () => {
  const h = harness();
  // A is running and being watched.
  const showA = h.poller.show('A');
  h.fetches[0].resolve({ id: 'A', status: 'running' });
  await showA;
  h.fire(); // A's poll tick — fetch #1 now in flight

  // User switches to B while A's response is still in the air.
  const showB = h.poller.show('B');
  h.fetches[2].resolve({ id: 'B', status: 'running' });
  await showB;
  expect(h.poller.watching()).toBe('B');

  // A's stale response lands, reporting A finished.
  h.fetches[1].resolve({ id: 'A', status: 'done' });
  await new Promise((r) => setTimeout(r, 0));

  // B must still be the watched job with a live timer; A's completion must not
  // have fired the finished callback or painted over B.
  expect(h.poller.watching()).toBe('B');
  expect(h.finishedCount()).toBe(0);
  expect(h.rendered.filter((j) => j.id === 'A')).toHaveLength(1); // only A's initial render
});

test('of two rapid selections, the slower initial response must not paint over the newer one', async () => {
  const h = harness();
  const showA = h.poller.show('A'); // fetch #0 in flight
  const showB = h.poller.show('B'); // fetch #1 in flight
  h.fetches[1].resolve({ id: 'B', status: 'running' });
  h.fetches[0].resolve({ id: 'A', status: 'done' }); // slower A lands after B
  await Promise.all([showA, showB]);
  expect(h.rendered).toEqual([{ id: 'B', status: 'running' }]);
  expect(h.poller.watching()).toBe('B');
});

test('a failed initial fetch shows the error only when the selection was not superseded', async () => {
  const h = harness();
  // Still-selected failure: error is rendered.
  const showA = h.poller.show('A');
  h.fetches[0].reject(new Error('nope'));
  await showA;
  expect(h.errors).toHaveLength(1);
  expect(h.poller.watching()).toBe(null);

  // Superseded failure: B's late rejection renders nothing and leaves C alone.
  const showB = h.poller.show('B'); // fetch #1 in flight
  const showC = h.poller.show('C'); // fetch #2 — C takes over
  h.fetches[2].resolve({ id: 'C', status: 'running' });
  await showC;
  h.fetches[1].reject(new Error('late'));
  await showB;
  expect(h.errors).toHaveLength(1);
  expect(h.poller.watching()).toBe('C');
});

test('render returning false (detail view gone) stops the loop', async () => {
  let renders = 0;
  const timers = [];
  const poller = createFleetPoller({
    fetchJob: () => Promise.resolve({ status: 'running' }),
    render: () => { renders += 1; return renders > 1 ? false : true; },
    renderError: () => {},
    onFinished: () => {},
    schedule: (fn) => { timers.push(fn); return timers.length - 1; },
    cancel: (t) => { timers[t] = null; },
  });
  await poller.show('A');
  const fn = timers.pop(); fn();
  await new Promise((r) => setTimeout(r, 0));
  expect(poller.watching()).toBe(null);
  expect(timers.filter(Boolean)).toHaveLength(0);
});
