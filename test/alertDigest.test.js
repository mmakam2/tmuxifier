import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createDigestScheduler } from '../src/server/alertDigest.js';

const at = (iso) => Date.parse(iso);
const mk = async ({ alerts = [] } = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-'));
  let t = at('2026-07-25T09:00:00Z');
  const sent = [];
  const log = createEventLog({ dir, prefix: 'checks', now: () => t });
  const decisionLog = createEventLog({ dir, prefix: 'decisions', now: () => t });
  const mailer = { send: async (m) => { sent.push(m); return { ok: true, error: null }; } };
  // Built through a factory so a test can stand up a second scheduler over the
  // same logs — which is what a restart looks like from the digest's side.
  const build = () => createDigestScheduler({
    alertManager: { listAlerts: async () => alerts },
    eventLogs: [log], decisionLog, mailer,
    now: () => t, retentionDays: 90, digestHourUtc: 8,
  });
  return { sched: build(), build, sent, clock: { get: () => t, set: (v) => { t = v; } }, log, decisionLog, dir };
};
const alert = (over = {}) => ({
  key: 'check:c1', source: 'check:c1', severity: 'info', state: 'firing',
  count: 2, recentCount: 2, firstTs: 0, lastTs: 0, title: 'Backup ran long', body: '',
  reason: 'skipped:info', ...over,
});

test('the digest sends once after the configured hour', async () => {
  const { sched, sent } = await mk({ alerts: [alert()] });
  await sched.tick();
  expect(sent).toHaveLength(1);
  expect(sent[0].subject).toContain('2026-07-25');
});

test('a second tick the same day sends nothing more', async () => {
  const { sched, sent, clock } = await mk({ alerts: [alert()] });
  await sched.tick();
  clock.set(at('2026-07-25T18:00:00Z'));
  await sched.tick();
  expect(sent).toHaveLength(1);
});

test('the next day sends again', async () => {
  const { sched, sent, clock } = await mk({ alerts: [alert()] });
  await sched.tick();
  clock.set(at('2026-07-26T09:00:00Z'));
  await sched.tick();
  expect(sent).toHaveLength(2);
});

test('before the configured hour nothing is sent', async () => {
  const { sched, sent, clock } = await mk({ alerts: [alert()] });
  clock.set(at('2026-07-25T07:00:00Z'));
  await sched.tick();
  expect(sent).toHaveLength(0);
});

test('notified alerts are excluded — the digest is what stayed below the line', async () => {
  const { sched, sent } = await mk({ alerts: [alert({ reason: 'notified', title: 'Already paged you' })] });
  await sched.tick();
  expect(sent[0].text).not.toContain('Already paged you');
});

test('the digest carries the loop-guard header like every other outbound message', async () => {
  const { sched, sent } = await mk({ alerts: [alert()] });
  await sched.tick();
  expect(sent[0].headers['X-Tmuxifier-Alert']).toBe('1');
});

test('the same pass prunes day files past the retention window', async () => {
  const { sched, log, clock, dir } = await mk();
  clock.set(at('2026-01-01T00:00:00Z'));
  await log.append({ key: 'old', ts: at('2026-01-01T00:00:00Z') });
  clock.set(at('2026-07-25T09:00:00Z'));
  await sched.tick();
  const names = await fs.readdir(dir);
  expect(names).not.toContain('checks-2026-01-01.ndjson');
});

// "Already sent today" cannot live only in memory. A deploy restart is routine
// and every restart past digestHourUtc would send the day's digest again — so
// the one message whose entire purpose is to be a calm daily summary would
// arrive once per restart. alertManager.js already faced this for cooldowns and
// re-derives its watermark from the append-only decision log rather than holding
// it in memory; the digest follows that decision instead of contradicting it.
test('a restart the same day does not re-send the digest', async () => {
  const { sched, build, sent } = await mk({ alerts: [alert()] });
  await sched.tick();
  expect(sent).toHaveLength(1);
  await build().tick(); // fresh process, same logs on disk
  expect(sent).toHaveLength(1);
});

test('a restart the next day still sends that day digest', async () => {
  const { sched, build, sent, clock } = await mk({ alerts: [alert()] });
  await sched.tick();
  clock.set(at('2026-07-26T09:00:00Z'));
  await build().tick();
  expect(sent).toHaveLength(2);
});

// The marker rides the decision log, which alertManager.js also reads. It must
// not be mistaken for a delivered alert notification there: lastNotifiedMap()
// keys a cooldown off reason === 'notified', so a digest marker wearing that
// reason would silence a real alert for the whole cooldown window.
test('the digest marker is not recorded as a notified alert decision', async () => {
  const { sched, decisionLog } = await mk({ alerts: [alert()] });
  await sched.tick();
  const decisions = await decisionLog.readSince(0);
  expect(decisions.length).toBeGreaterThan(0);
  expect(decisions.every((d) => d.reason !== 'notified')).toBe(true);
});

test('a failed digest send is not remembered as sent, so the next tick retries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'digest-'));
  let t = at('2026-07-25T09:00:00Z');
  const sent = [];
  let failNext = true;
  const sched = createDigestScheduler({
    alertManager: { listAlerts: async () => [alert()] },
    eventLogs: [createEventLog({ dir, prefix: 'checks', now: () => t })],
    decisionLog: createEventLog({ dir, prefix: 'decisions', now: () => t }),
    mailer: {
      send: async (m) => {
        if (failNext) { failNext = false; return { ok: false, error: 'relay refused' }; }
        sent.push(m); return { ok: true, error: null };
      },
    },
    now: () => t, retentionDays: 90, digestHourUtc: 8,
  });
  const first = await sched.tick();
  expect(first.ok).toBe(false);
  expect(sent).toHaveLength(0);
  t = at('2026-07-25T10:00:00Z');
  await sched.tick();
  expect(sent).toHaveLength(1);
});
