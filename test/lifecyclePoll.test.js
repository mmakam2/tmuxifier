import { test, expect } from 'vitest';
import { lifecyclePollStep, MAX_TRANSIENT_FAILURES } from '../src/web/lifecyclePoll.ts';

// E4 (2026-07-29 review). The lifecycle job viewer caught every error to null
// and rescheduled, so a pruned job id polled forever behind an empty log with
// nothing on screen to explain it. The bug was not the retry — it was that one
// null stood for two different situations.

test('a running job keeps polling', () => {
  expect(lifecyclePollStep({ job: { status: 'running' }, errorStatus: 0, failures: 0 }))
    .toEqual({ action: 'render', done: false });
});

test('a settled job renders and stops', () => {
  for (const status of ['done', 'error', 'interrupted']) {
    expect(lifecyclePollStep({ job: { status }, errorStatus: 0, failures: 0 }))
      .toEqual({ action: 'render', done: true });
  }
});

// The whole point of the row: 404 is an answer, not a failure to get one.
test('a 404 gives up at once — no id, no amount of waiting brings it back', () => {
  const step = lifecyclePollStep({ job: null, errorStatus: 404, failures: 0 });
  expect(step.action).toBe('give-up');
  expect(step.message).toMatch(/pruned/);
});

test('a transient failure retries', () => {
  expect(lifecyclePollStep({ job: null, errorStatus: 0, failures: 0 })).toEqual({ action: 'retry' });
  expect(lifecyclePollStep({ job: null, errorStatus: 503, failures: 1 })).toEqual({ action: 'retry' });
});

// Bounded, so a controller that has stopped answering ends in a message rather
// than a timer nobody can see.
test('transient failures are capped rather than retried forever', () => {
  const last = lifecyclePollStep({ job: null, errorStatus: 0, failures: MAX_TRANSIENT_FAILURES - 1 });
  expect(last.action).toBe('give-up');
  expect(last.message).toMatch(new RegExp(`${MAX_TRANSIENT_FAILURES} attempts`));
});

test('the cap counts consecutive failures, so the step just below it still retries', () => {
  expect(lifecyclePollStep({ job: null, errorStatus: 0, failures: MAX_TRANSIENT_FAILURES - 2 }))
    .toEqual({ action: 'retry' });
});

// A 401 means the shared seam is already tearing the workspace down; polling on
// behind the login screen is the B6/B28 shape and must not reappear here.
test('a 401 stops immediately rather than polling behind the login screen', () => {
  const step = lifecyclePollStep({ job: null, errorStatus: 401, failures: 0 });
  expect(step.action).toBe('give-up');
  expect(step.message).toMatch(/Session expired/);
});

// A job that arrives after some failures is still just a job — the failure
// count must not leak into the decision.
test('a successful poll after failures renders normally', () => {
  expect(lifecyclePollStep({ job: { status: 'running' }, errorStatus: 0, failures: MAX_TRANSIENT_FAILURES - 1 }))
    .toEqual({ action: 'render', done: false });
});
