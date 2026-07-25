// test/alertManager.test.js
import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createAlertStateStore } from '../src/server/alertStateStore.js';
import { createAlertManager } from '../src/server/alertManager.js';

const mk = async ({ delivers = async () => ({ ok: true }), lookbackMs } = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertmgr-'));
  let t = 1000;
  const clock = { get: () => t, advance: (ms) => { t += ms; } };
  const checks = createEventLog({ dir: dataDir, prefix: 'checks', now: () => clock.get() });
  const decisions = createEventLog({ dir: dataDir, prefix: 'decisions', now: () => clock.get() });
  const sent = [];
  const manager = createAlertManager({
    eventLogs: [checks], decisionLog: decisions,
    stateStore: createAlertStateStore({ dataDir, now: () => clock.get() }),
    channels: [{ name: 'mail', deliver: async (a, r) => { sent.push({ key: a.key, reason: r }); return delivers(); } }],
    now: () => clock.get(),
    ...(lookbackMs !== undefined ? { lookbackMs } : {}),
  });
  return { manager, checks, decisions, clock, sent, dataDir };
};
const firing = (over = {}) => ({
  via: 'check', source: 'check:c1', key: 'check:c1', norm: null,
  severity: 'critical', state: 'firing', title: 'Invoice app: HTTP 502', body: '', ...over,
});

test('a critical alert notifies once and records the decision', async () => {
  const { manager, checks, decisions, sent } = await mk();
  await checks.append(firing());
  const got = await manager.evaluate();
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ key: 'check:c1', reason: 'notified', notify: true });
  expect(sent).toEqual([{ key: 'check:c1', reason: 'notified' }]);
  expect((await decisions.readSince(0))[0].reason).toBe('notified');
});

test('a second evaluation inside the cooldown records suppression and sends nothing more', async () => {
  const { manager, checks, clock, sent, decisions } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  clock.advance(60000);
  await checks.append(firing());
  await manager.evaluate();
  expect(sent).toHaveLength(1);
  const reasons = (await decisions.readSince(0)).map((d) => d.reason);
  expect(reasons).toEqual(['notified', 'suppressed:cooldown']);
});

test('a withheld alert is still recorded, so nothing is ever silently dropped', async () => {
  const { manager, checks, decisions, sent } = await mk();
  await checks.append(firing({ severity: 'warning' }));
  await manager.evaluate();
  expect(sent).toEqual([]);
  expect((await decisions.readSince(0))[0].reason).toBe('held:below-persistence');
});

test('a delivery failure is recorded as notify:failed and does not consume the cooldown', async () => {
  const { manager, checks, decisions, clock } = await mk({ delivers: async () => ({ ok: false, error: 'relay down' }) });
  await checks.append(firing());
  await manager.evaluate();
  expect((await decisions.readSince(0))[0]).toMatchObject({ reason: 'notify:failed', error: 'relay down', notify: false });
  clock.advance(60000);
  await checks.append(firing());
  await manager.evaluate();
  // The retry is a fresh attempt rather than a cooldown suppression: a failed
  // send must not count as having reached anyone.
  expect((await decisions.readSince(0)).map((d) => d.reason)).toEqual(['notify:failed', 'notify:failed']);
});

test('decisions are re-derived after a restart without duplicate notifications', async () => {
  const { manager, checks, decisions, dataDir, clock, sent } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  const restarted = createAlertManager({
    eventLogs: [createEventLog({ dir: dataDir, prefix: 'checks', now: () => clock.get() })],
    decisionLog: decisions,
    stateStore: createAlertStateStore({ dataDir, now: () => clock.get() }),
    channels: [{ name: 'mail', deliver: async () => { sent.push('again'); return { ok: true }; } }],
    now: () => clock.get(),
  });
  clock.advance(60000);
  await restarted.evaluate();
  expect(sent).toHaveLength(1); // the pre-restart notification is honoured, not repeated
});

test('listAlerts returns folded open alerts with their latest decision reason', async () => {
  const { manager, checks } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  const [alert] = await manager.listAlerts();
  expect(alert).toMatchObject({ key: 'check:c1', count: 1, state: 'firing', reason: 'notified' });
});

test('a resolved alert stops notifying and is recorded as skipped:resolved', async () => {
  const { manager, checks, decisions, clock } = await mk();
  await checks.append(firing());
  await manager.evaluate();
  clock.advance(60000);
  await checks.append(firing({ state: 'resolved', title: 'Invoice app recovered' }));
  await manager.evaluate();
  expect((await decisions.readSince(0)).map((d) => d.reason)).toEqual(['notified', 'skipped:resolved']);
});

// --- Additional tests beyond the brief, targeting behavior the 7 tests above
// don't exercise but the task explicitly calls out as mutation risk. ---

test('concurrent evaluate() calls are coalesced into a single evaluation', async () => {
  const { manager, checks, decisions, sent } = await mk();
  await checks.append(firing());
  const [a, b] = await Promise.all([manager.evaluate(), manager.evaluate()]);
  // Without coalescing, both calls would independently see lastNotifiedAt=null
  // (neither has committed a decision yet) and both would decide 'notified',
  // doubling the delivery and the decision-log write.
  expect(a).toEqual(b);
  expect(sent).toHaveLength(1);
  expect(await decisions.readSince(0)).toHaveLength(1);
});

test('the decision is recorded only after delivery resolves, never before', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertmgr-'));
  const now = () => 1000;
  const checks = createEventLog({ dir: dataDir, prefix: 'checks', now });
  const decisions = createEventLog({ dir: dataDir, prefix: 'decisions', now });
  const stateStore = createAlertStateStore({ dataDir, now });
  let sawDuringDelivery = null;
  const manager = createAlertManager({
    eventLogs: [checks], decisionLog: decisions, stateStore, now,
    channels: [{
      name: 'mail',
      deliver: async () => {
        // If a caller recorded the decision optimistically before delivery,
        // this read would already see it.
        sawDuringDelivery = (await decisions.readSince(0)).length;
        return { ok: true };
      },
    }],
  });
  await checks.append(firing());
  await manager.evaluate();
  expect(sawDuringDelivery).toBe(0);
  expect(await decisions.readSince(0)).toHaveLength(1);
});

test('one channel that throws does not crash evaluation or block other alerts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertmgr-'));
  const now = () => 1000;
  const checks = createEventLog({ dir: dataDir, prefix: 'checks', now });
  const decisions = createEventLog({ dir: dataDir, prefix: 'decisions', now });
  const stateStore = createAlertStateStore({ dataDir, now });
  const sent = [];
  const manager = createAlertManager({
    eventLogs: [checks], decisionLog: decisions, stateStore, now,
    channels: [{
      name: 'flaky',
      deliver: async (alert) => {
        if (alert.key === 'check:bad') throw new Error('boom');
        sent.push(alert.key);
        return { ok: true };
      },
    }],
  });
  await checks.append(firing({ key: 'check:bad', source: 'check:bad' }));
  await checks.append(firing({ key: 'check:good', source: 'check:good' }));
  const got = await manager.evaluate(); // must resolve, not reject
  expect(got).toHaveLength(2);
  const byKey = Object.fromEntries(got.map((d) => [d.key, d]));
  expect(byKey['check:bad']).toMatchObject({ reason: 'notify:failed', error: 'boom' });
  expect(byKey['check:good']).toMatchObject({ reason: 'notified' });
  expect(sent).toEqual(['check:good']); // the throwing channel didn't stop the other alert's delivery
});

test('an event older than the lookback window ages out of evaluation', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertmgr-'));
  let t = 1000;
  const lookbackMs = 100000;
  const checks = createEventLog({ dir: dataDir, prefix: 'checks', now: () => t });
  const decisions = createEventLog({ dir: dataDir, prefix: 'decisions', now: () => t });
  const stateStore = createAlertStateStore({ dataDir, now: () => t });
  const manager = createAlertManager({
    eventLogs: [checks], decisionLog: decisions, stateStore, channels: [],
    now: () => t, lookbackMs,
  });
  await checks.append(firing());
  expect(await manager.listAlerts()).toHaveLength(1);
  t += lookbackMs + 1;
  expect(await manager.listAlerts()).toEqual([]);
});

test('a warning alert that persists past the threshold eventually notifies', async () => {
  const { manager, checks, decisions, clock, sent } = await mk();
  await checks.append(firing({ severity: 'warning' }));
  await manager.evaluate();
  clock.advance(16 * 60 * 1000); // past DEFAULT_THRESHOLDS.warnPersistMs (15 min)
  await manager.evaluate(); // same underlying event, now old enough to clear the persistence gate
  const reasons = (await decisions.readSince(0)).map((d) => d.reason);
  expect(reasons).toEqual(['held:below-persistence', 'notified']);
  expect(sent).toHaveLength(1);
});

test('events from multiple eventLogs are all folded and evaluated', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'alertmgr-'));
  const now = () => 1000;
  const checks = createEventLog({ dir: dataDir, prefix: 'checks', now });
  const health = createEventLog({ dir: dataDir, prefix: 'health', now });
  const decisions = createEventLog({ dir: dataDir, prefix: 'decisions', now });
  const stateStore = createAlertStateStore({ dataDir, now });
  const manager = createAlertManager({
    eventLogs: [checks, health], decisionLog: decisions, stateStore, channels: [], now,
  });
  await checks.append(firing({ key: 'check:c1', source: 'check:c1' }));
  await health.append(firing({ key: 'health:h1', source: 'health:h1', via: 'health' }));
  const keys = (await manager.listAlerts()).map((a) => a.key).sort();
  expect(keys).toEqual(['check:c1', 'health:h1']);
});
