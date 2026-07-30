import { test, expect } from 'vitest';
import { armReduce, IDLE, ARM_MS } from '../src/web/arming.ts';

// The shared arm-then-fire policy, lifted out of paneLifecycle.ts so the
// Reconnect buttons inherit it rather than carry a second copy. paneLifecycle's
// own tests still exercise it through its wrapper, which is what pins the
// refactor: both callers must agree on every case below.

const click = (id, armable = true) => ({ type: 'click', id, armable });

test('an armable control needs two clicks: the first arms, the second fires', () => {
  const armed = armReduce(IDLE, click('shutdown'));
  expect(armed).toEqual({ state: { armed: 'shutdown' }, fire: null });
  expect(armReduce(armed.state, click('shutdown'))).toEqual({ state: { armed: null }, fire: 'shutdown' });
});

test('a non-armable control fires on the first click', () => {
  expect(armReduce(IDLE, click('start', false))).toEqual({ state: { armed: null }, fire: 'start' });
});

test('a non-armable control also disarms whatever was armed', () => {
  const armed = armReduce(IDLE, click('shutdown')).state;
  expect(armReduce(armed, click('start', false))).toEqual({ state: { armed: null }, fire: 'start' });
});

test('clicking a sibling moves the arm instead of firing either control', () => {
  const armed = armReduce(IDLE, click('shutdown')).state;
  expect(armReduce(armed, click('reboot'))).toEqual({ state: { armed: 'reboot' }, fire: null });
});

test('timeout, dismiss and reset all disarm without firing', () => {
  const armed = armReduce(IDLE, click('stop')).state;
  for (const type of ['timeout', 'dismiss', 'reset']) {
    expect(armReduce(armed, { type })).toEqual({ state: { armed: null }, fire: null });
  }
});

test('a third click cannot re-fire: committing disarms in the same step', () => {
  const armed = armReduce(IDLE, click('stop')).state;
  const fired = armReduce(armed, click('stop'));
  expect(fired.fire).toBe('stop');
  // The state handed back is idle, so the next click arms again rather than
  // firing a second job.
  expect(armReduce(fired.state, click('stop'))).toEqual({ state: { armed: 'stop' }, fire: null });
});

test('the arm window is short but usable', () => {
  expect(ARM_MS).toBeGreaterThanOrEqual(2000);
  expect(ARM_MS).toBeLessThanOrEqual(5000);
});
