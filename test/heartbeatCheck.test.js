import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { runHeartbeatCheck } from '../src/server/checks/heartbeatCheck.js';

const HOUR = 3600000;
const mk = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hbcheck-'));
  let t = Date.parse('2026-07-25T12:00:00Z');
  return { dir, clock: { get: () => t, set: (v) => { t = v; } } };
};
const check = (over = {}) => ({
  id: 'c1', type: 'heartbeat', target: { windowSec: 3600, graceSec: 300 }, ...over,
});
const checkin = (key = 'check:c1') => ({
  via: 'heartbeat', source: key, key, state: 'checkin', severity: 'info', title: 'check-in', body: '',
});

test('a recent check-in passes', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append(checkin());
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(true);
});

test('a check-in inside the grace period still passes', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append(checkin());
  clock.set(clock.get() + HOUR + 200000); // window elapsed, still inside the 300s grace
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(true);
});

test('no check-in past window plus grace fails, and the detail says how long it has been', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append(checkin());
  clock.set(clock.get() + 3 * HOUR);
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/no check-in/i);
});

test('a heartbeat that has never checked in fails rather than passing vacuously', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/never/i);
});

test('another check-in key does not satisfy this check', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append(checkin('check:other'));
  const got = await runHeartbeatCheck(check(), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
});

// This is the one check that fires because nothing happened, which makes a
// false green uniquely bad here: the whole point is catching the backup that
// never ran, and every one of these inputs would otherwise arithmetic its way
// to ok:true. NaN loses every comparison, so `age > NaN` is false and the
// check reports healthy — silence read as success, which is the exact outcome
// this check type exists to prevent.
test('a heartbeat with no window configured fails rather than reporting healthy', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append(checkin());
  clock.set(clock.get() + 30 * 24 * HOUR);
  const got = await runHeartbeatCheck(check({ target: {} }), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
});

test('a heartbeat with a non-numeric window fails rather than reporting healthy', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  await log.append(checkin());
  const got = await runHeartbeatCheck(
    check({ target: { windowSec: 'soon', graceSec: 0 } }), { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
});

// Not written through append(), which resolves a non-numeric ts to now() and so
// can never produce this. It comes off disk: readFileLines JSON.parses each
// line without validating its shape, so a hand-edited or half-written line in
// checkins-*.ndjson reaches the executor as-is. An unusable timestamp makes
// `now() - ts` NaN, and NaN > windowMs is false — the corrupt line would report
// the heartbeat healthy.
test('a check-in whose timestamp is corrupt does not satisfy the check', async () => {
  const got = await runHeartbeatCheck(check(), {
    checkinLog: { readSince: async () => [{ key: 'check:c1', state: 'checkin', ts: 'yesterday' }] },
    now: () => Date.parse('2026-07-25T12:00:00Z'),
  });
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/never/i);
});

test('a log read failure fails the check rather than throwing', async () => {
  const got = await runHeartbeatCheck(check(), {
    checkinLog: { readSince: async () => { throw new Error('events dir unreadable'); } },
    now: () => 0,
  });
  expect(got.ok).toBe(false);
  expect(got.detail).toMatch(/unreadable/);
});

test('a missing check object fails rather than throwing', async () => {
  const { dir, clock } = await mk();
  const log = createEventLog({ dir, prefix: 'checkins', now: () => clock.get() });
  const got = await runHeartbeatCheck(undefined, { checkinLog: log, now: () => clock.get() });
  expect(got.ok).toBe(false);
  expect(got.detail).toBeTruthy();
});
