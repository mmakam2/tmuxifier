import { test, expect } from 'vitest';
import { lifecycleKeysFor, armReduce, chipFor, IDLE } from '../src/web/paneLifecycle.ts';

const actions = (keys) => keys.map((k) => k.action);
const keyFor = (paneState, pveState, action) =>
  lifecycleKeysFor(paneState, pveState).find((k) => k.action === action);

test('a running container offers shutdown, reboot and force stop', () => {
  expect(actions(lifecycleKeysFor('terminal', 'running'))).toEqual(['shutdown', 'reboot', 'stop']);
});

test('only force stop is marked danger', () => {
  const keys = lifecycleKeysFor('terminal', 'running');
  expect(keys.filter((k) => k.danger).map((k) => k.action)).toEqual(['stop']);
});

test('a stopped pane offers start', () => {
  expect(actions(lifecycleKeysFor('stopped', 'stopped'))).toEqual(['start']);
});

// paneState is sticky through a failed PVE read (see paneState in main.ts): a
// stopped pane must not lose its Start key just because the probe went blind.
test('a stopped pane keeps start when the PVE read is unknown', () => {
  expect(actions(lifecycleKeysFor('stopped', 'unknown'))).toEqual(['start']);
});

test('missing, unknown and absent PVE state offer nothing', () => {
  expect(lifecycleKeysFor('terminal', 'missing')).toEqual([]);
  expect(lifecycleKeysFor('terminal', 'unknown')).toEqual([]);
  expect(lifecycleKeysFor('terminal', undefined)).toEqual([]);
});

// A box mid-setup is running, but every one of these actions would interrupt
// the setup job that just provisioned it.
test('a setting-up pane offers nothing even while the container runs', () => {
  expect(lifecycleKeysFor('setup', 'running')).toEqual([]);
});

test('deprovision is never offered', () => {
  const everyKey = ['terminal', 'stopped', 'setup'].flatMap((pane) =>
    ['running', 'stopped', 'missing', 'unknown'].flatMap((pve) => lifecycleKeysFor(pane, pve)));
  expect(everyKey.some((k) => k.action === 'deprovision')).toBe(false);
});

test('start fires on the first click and never arms', () => {
  const start = keyFor('stopped', 'stopped', 'start');
  expect(start.armLegend).toBeNull();
  expect(armReduce(IDLE, { type: 'click', key: start })).toEqual({ state: { armed: null }, fire: 'start' });
});

test('a destructive key arms on the first click and fires on the second', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown });
  expect(armed).toEqual({ state: { armed: 'shutdown' }, fire: null });
  expect(armReduce(armed.state, { type: 'click', key: shutdown })).toEqual({ state: { armed: null }, fire: 'shutdown' });
});

test('clicking a different key moves the arm rather than firing', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const reboot = keyFor('terminal', 'running', 'reboot');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown }).state;
  expect(armReduce(armed, { type: 'click', key: reboot })).toEqual({ state: { armed: 'reboot' }, fire: null });
});

test('start clears an arm without firing the armed action', () => {
  const shutdown = keyFor('terminal', 'running', 'shutdown');
  const start = keyFor('stopped', 'stopped', 'start');
  const armed = armReduce(IDLE, { type: 'click', key: shutdown }).state;
  expect(armReduce(armed, { type: 'click', key: start })).toEqual({ state: { armed: null }, fire: 'start' });
});

test('timeout, dismissal and a key-set change all disarm without firing', () => {
  const stop = keyFor('terminal', 'running', 'stop');
  const armed = armReduce(IDLE, { type: 'click', key: stop }).state;
  for (const type of ['timeout', 'dismiss', 'keysChanged']) {
    expect(armReduce(armed, { type })).toEqual({ state: { armed: null }, fire: null });
  }
});

test('chipFor reads the action in progress', () => {
  expect(chipFor('shutdown', 'running')).toEqual({ text: 'shutting down…', cls: 'chip-state', settled: false });
  expect(chipFor('reboot', 'running').text).toBe('rebooting…');
  expect(chipFor('stop', 'running').text).toBe('stopping…');
  expect(chipFor('start', 'running').text).toBe('starting…');
});

test('a done job clears the chip', () => {
  expect(chipFor('shutdown', 'done')).toBeNull();
});

test('error and interrupted settle red', () => {
  expect(chipFor('shutdown', 'error')).toEqual({ text: 'shutdown failed', cls: 'chip-error', settled: true });
  expect(chipFor('reboot', 'interrupted')).toEqual({ text: 'reboot failed', cls: 'chip-error', settled: true });
});

test('a job we lost track of settles red with its own wording', () => {
  expect(chipFor('stop', 'lost')).toEqual({ text: 'lost track of job', cls: 'chip-error', settled: true });
});
