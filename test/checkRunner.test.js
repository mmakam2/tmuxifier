import { test, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEventLog } from '../src/server/eventLog.js';
import { createCheckRunner } from '../src/server/checkRunner.js';
import { createCheckDispatcher } from '../src/server/checks/index.js';

const mk = async (checks, results) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  let t = 1000;
  const clock = { get: () => t, set: (v) => { t = v; }, advance: (ms) => { t += ms; } };
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => clock.get() });
  const dispatcher = createCheckDispatcher({
    runners: { http: async (c) => results[c.id].shift() ?? { ok: true, detail: 'ok', latencyMs: 1 } },
  });
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => checks, getCheck: async (id) => checks.find((c) => c.id === id) },
    dispatcher, eventLog, now: () => clock.get(), jitter: () => 0,
  });
  return { runner, eventLog, clock, dir };
};
const chk = (over) => ({
  id: 'c1', label: 'Invoice app', type: 'http', target: { url: 'https://invoices.example.com/health' },
  assert: {}, intervalSec: 30, timeoutMs: 1000, severity: 'critical',
  failuresBeforeNotify: 2, enabled: true, ...over,
});

test('a failing check appends one firing occurrence per failed run', async () => {
  const { runner, eventLog } = await mk([chk()], { c1: [{ ok: false, detail: 'HTTP 502', latencyMs: 4 }] });
  await runner.runDue();
  const events = await eventLog.readSince(0);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    via: 'check', key: 'check:c1', source: 'check:c1', severity: 'critical', state: 'firing',
  });
  expect(events[0].title).toContain('HTTP 502');
});

test('a passing check emits nothing at all — silence is the normal case', async () => {
  const { runner, eventLog } = await mk([chk()], { c1: [{ ok: true, detail: 'HTTP 200', latencyMs: 3 }] });
  await runner.runDue();
  expect(await eventLog.readSince(0)).toEqual([]);
});

test('recovery requires two consecutive successes, so a flapping check emits no resolution', async () => {
  const { runner, eventLog, clock } = await mk([chk()], {
    c1: [
      { ok: false, detail: 'down', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
      { ok: false, detail: 'down', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
    ],
  });
  for (let i = 0; i < 4; i++) { await runner.runDue(); clock.advance(30000); }
  const events = await eventLog.readSince(0);
  expect(events.filter((e) => e.state === 'resolved')).toHaveLength(0);
  expect(events.filter((e) => e.state === 'firing')).toHaveLength(2);
});

test('two consecutive successes after a failure emit exactly one resolution', async () => {
  const { runner, eventLog, clock } = await mk([chk()], {
    c1: [
      { ok: false, detail: 'down', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
    ],
  });
  for (let i = 0; i < 4; i++) { await runner.runDue(); clock.advance(30000); }
  const resolved = (await eventLog.readSince(0)).filter((e) => e.state === 'resolved');
  expect(resolved).toHaveLength(1);
});

test('a check is not run again before its interval elapses', async () => {
  let calls = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  let t = 1000;
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({ runners: { http: async () => { calls++; return { ok: true, detail: '', latencyMs: 1 }; } } }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => t }),
    now: () => t, jitter: () => 0,
  });
  await runner.runDue();
  t += 5000;
  await runner.runDue();
  expect(calls).toBe(1);
  t += 30000;
  await runner.runDue();
  expect(calls).toBe(2);
});

test('a disabled check never runs', async () => {
  const { runner, eventLog } = await mk([chk({ enabled: false })], { c1: [{ ok: false, detail: 'x', latencyMs: 1 }] });
  await runner.runDue();
  expect(await eventLog.readSince(0)).toEqual([]);
});

test('an executor that throws becomes a check failure, never an unhandled rejection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({ runners: { http: async () => { throw new Error('boom'); } } }),
    eventLog, now: () => 1000, jitter: () => 0,
  });
  await runner.runDue();
  const events = await eventLog.readSince(0);
  expect(events).toHaveLength(1);
  expect(events[0].title).toContain('boom');
});

test('overlapping cycles are coalesced so a slow check never runs twice at once', async () => {
  let active = 0, peak = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({
      runners: { http: async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--; return { ok: true, detail: '', latencyMs: 1 };
      } },
    }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 0,
  });
  await Promise.all([runner.runDue(), runner.runDue(), runner.runDue()]);
  expect(peak).toBe(1);
});

test('getState reports the last result and the next due time', async () => {
  const { runner } = await mk([chk()], { c1: [{ ok: false, detail: 'HTTP 502', latencyMs: 7 }] });
  await runner.runDue();
  expect(runner.getState().c1).toMatchObject({
    ok: false, consecutiveFail: 1, consecutiveOk: 0, detail: 'HTTP 502', latencyMs: 7, nextRunAt: 31000,
  });
});

// Every other test pins jitter: () => 0, which cannot tell "jitter(1000) is
// added to nextRunAt" apart from "the jitter term was never wired up at all" —
// deleting `+ jitter(1000)` from the runner leaves the whole suite green
// without this one. A non-zero, easily-distinguished offset (500, not a
// multiple of the 30000ms interval) makes the addition unambiguous.
test('nextRunAt incorporates the injected jitter offset on top of the interval', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({ runners: { http: async () => ({ ok: true, detail: '', latencyMs: 1 }) } }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 500,
  });
  await runner.runDue();
  expect(runner.getState().c1.nextRunAt).toBe(1000 + 30000 + 500);
});

test('the sealed secret is resolved for a due check so executors can authenticate', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const seen = [];
  const redacted = { ...chk(), hasSecret: true };
  const runner = createCheckRunner({
    checkStore: {
      // A listing is redacted, exactly as checkStore.listChecks returns it.
      listChecks: async () => [redacted],
      getCheck: async (_id, opts) => (opts?.withSecret ? { ...chk(), secret: 'tok-abc' } : redacted),
    },
    dispatcher: createCheckDispatcher({
      runners: { http: async (c) => { seen.push(c.secret); return { ok: true, detail: '', latencyMs: 1 }; } },
    }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 0,
  });
  await runner.runDue();
  expect(seen).toEqual(['tok-abc']);
});

test('an unknown type fails the check with a readable detail instead of crashing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk({ type: 'tcp' })], getCheck: async () => chk({ type: 'tcp' }) },
    dispatcher: createCheckDispatcher({ runners: {} }),
    eventLog, now: () => 1000, jitter: () => 0,
  });
  await runner.runDue();
  expect((await eventLog.readSince(0))[0].title).toMatch(/no executor/i);
});

// --- Additions beyond the brief's Step 1, closing gaps the mutation pass found ---

// checkStore.getCheck(id, { withSecret: true }) returns secret: null for a check
// with nothing configured (checkStore.js: `found.secret ? secretBox.open(...) : null`).
// Contract 1 explicitly requires this path not to throw — an executor that assumes
// a secret is always a string (e.g. `check.secret.trim()`) would blow up here.
test('a check with no secret configured still runs — secret: null must not throw', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const seen = [];
  const runner = createCheckRunner({
    checkStore: {
      listChecks: async () => [{ ...chk(), hasSecret: false }],
      getCheck: async (_id, opts) => (opts?.withSecret ? { ...chk(), secret: null } : { ...chk(), hasSecret: false }),
    },
    dispatcher: createCheckDispatcher({
      runners: { http: async (c) => { seen.push(c.secret); return { ok: true, detail: '', latencyMs: 1 }; } },
    }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 0,
  });
  await runner.runDue();
  expect(seen).toEqual([null]);
});

// Contract 2, stated directly: one throwing check must not stop the others in the
// same cycle. concurrency: 1 forces a single mapWithConcurrency worker processing
// both checks sequentially in its while-loop — the exact shape that would stall
// entirely if the try/catch around dispatcher.run lived one level too high (i.e.
// outside checkRunner's execute()) instead of wrapping each check's own dispatch.
test('one check throwing does not stop other checks in the same cycle', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const checks = [chk({ id: 'c1' }), chk({ id: 'c2', label: 'Second app' })];
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => checks, getCheck: async (id) => checks.find((c) => c.id === id) },
    dispatcher: createCheckDispatcher({
      runners: { http: async (c) => {
        if (c.id === 'c1') throw new Error('boom');
        return { ok: false, detail: 'HTTP 502', latencyMs: 2 };
      } },
    }),
    eventLog, now: () => 1000, jitter: () => 0, concurrency: 1,
  });
  await runner.runDue();
  const events = await eventLog.readSince(0);
  expect(events).toHaveLength(2);
  expect(events.some((e) => e.key === 'check:c1' && e.title.includes('boom'))).toBe(true);
  expect(events.some((e) => e.key === 'check:c2' && e.title.includes('HTTP 502'))).toBe(true);
});

// Contract 2 again, but for the *other* place a due check can fail before it
// ever reaches the dispatcher: secretBox.open() (called inside the real
// checkStore.getCheck(id, { withSecret: true })) throws synchronously on a
// corrupted sealed value or a rotated cookieSecret — a real failure mode, not
// a hypothetical one. concurrency: 1 forces the single-worker sequential shape
// where an unguarded throw would kill the worker mid-loop and drop c2 entirely,
// with runDue() itself rejecting and NEITHER check getting an event — worse
// than "one check reported wrong": the monitor going silent for the whole
// cycle. Both halves are asserted: the broken check still gets a readable
// firing event, and the other due check in the same cycle still runs and
// still logs its own event.
test('a check whose secret fails to resolve does not stop another due check, and both get logged', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const eventLog = createEventLog({ dir, prefix: 'checks', now: () => 1000 });
  const checks = [chk({ id: 'c1' }), chk({ id: 'c2', label: 'Second app' })];
  const runner = createCheckRunner({
    checkStore: {
      listChecks: async () => checks,
      getCheck: async (id) => {
        if (id === 'c1') throw new Error('bad auth tag');
        return checks.find((c) => c.id === id);
      },
    },
    dispatcher: createCheckDispatcher({
      runners: { http: async () => ({ ok: false, detail: 'HTTP 502', latencyMs: 2 }) },
    }),
    eventLog, now: () => 1000, jitter: () => 0, concurrency: 1,
  });
  await runner.runDue();
  const events = await eventLog.readSince(0);
  expect(events).toHaveLength(2);
  expect(events.some((e) => e.key === 'check:c1'
    && e.state === 'firing'
    && e.title.includes('secret resolution failed')
    && e.title.includes('bad auth tag'))).toBe(true);
  expect(events.some((e) => e.key === 'check:c2' && e.state === 'firing' && e.title.includes('HTTP 502'))).toBe(true);
  expect(runner.getState().c1).toMatchObject({ ok: false, consecutiveFail: 1 });
  expect(runner.getState().c2).toMatchObject({ ok: false, consecutiveFail: 1 });
});

// Pins the reset-on-success (consecutiveFail -> 0) and reset-on-failure
// (consecutiveOk -> 0) lines individually: a sequence that revisits failure after
// one intervening success only stays at consecutiveFail: 1 if the counter was
// actually reset in between, not merely decremented or left alone.
test('consecutiveFail and consecutiveOk each reset when the run outcome flips', async () => {
  const { runner, clock } = await mk([chk()], {
    c1: [
      { ok: false, detail: 'down', latencyMs: 1 },
      { ok: true, detail: 'up', latencyMs: 1 },
      { ok: false, detail: 'down again', latencyMs: 1 },
    ],
  });
  await runner.runDue();
  expect(runner.getState().c1).toMatchObject({ consecutiveFail: 1, consecutiveOk: 0 });
  clock.advance(30000);
  await runner.runDue();
  expect(runner.getState().c1).toMatchObject({ consecutiveFail: 0, consecutiveOk: 1 });
  clock.advance(30000);
  await runner.runDue();
  // Without the consecutiveFail reset above, this would read 2, not 1.
  expect(runner.getState().c1).toMatchObject({ consecutiveFail: 1, consecutiveOk: 0 });
});

// runOne is the interactive/manual-recheck path (e.g. a "run now" button) and must
// not be gated by the schedule: it should dispatch even when nextRunAt is still in
// the future, unlike runDue.
test('runOne executes immediately even when the check is not yet due, with the secret resolved', async () => {
  let t = 1000;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const seen = [];
  const queue = [{ ok: false, detail: 'HTTP 502', latencyMs: 1 }, { ok: false, detail: 'HTTP 500', latencyMs: 2 }];
  const runner = createCheckRunner({
    checkStore: {
      listChecks: async () => [{ ...chk(), hasSecret: true }],
      getCheck: async (_id, opts) => (opts?.withSecret ? { ...chk(), secret: 's3cr3t' } : { ...chk(), hasSecret: true }),
    },
    dispatcher: createCheckDispatcher({ runners: { http: async (c) => { seen.push(c.secret); return queue.shift(); } } }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => t }),
    now: () => t, jitter: () => 0,
  });
  await runner.runDue(); // schedules nextRunAt 30s out and consumes the first queued result
  t += 1000; // well before the next scheduled run
  const result = await runner.runOne('c1');
  expect(result).toMatchObject({ ok: false, detail: 'HTTP 500' });
  expect(seen).toEqual(['s3cr3t', 's3cr3t']);
});

test('runOne returns null for an unknown check id instead of throwing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [], getCheck: async () => null },
    dispatcher: createCheckDispatcher({ runners: {} }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 0,
  });
  await expect(runner.runOne('nope')).resolves.toBeNull();
});

test('start runs an immediate cycle then schedules the recurring cycle', async () => {
  let calls = 0;
  let t = 1000;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const scheduled = [];
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({ runners: { http: async () => { calls++; return { ok: true, detail: '', latencyMs: 1 }; } } }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => t }),
    now: () => t, jitter: () => 0, intervalMs: 1000,
    setIntervalFn: (fn) => { scheduled.push(fn); return 42; },
  });
  await runner.start();
  expect(calls).toBe(1);
  expect(scheduled).toHaveLength(1);
  t += chk().intervalSec * 1000; // simulate the check's interval having elapsed
  scheduled[0]();
  // The scheduled callback is deliberately fire-and-forget (matching
  // statusPoller.js's own `setIntervalFn(() => { pollOnce().catch(...) }, ...)`),
  // so it returns no promise the test can await; a single macrotask tick lets
  // the checkStore -> dispatcher -> executor microtask chain it kicked off
  // fully drain (Node empties the microtask queue before running the next
  // macrotask), which a bare `await` on the callback's own `undefined` return
  // value cannot guarantee once more than one indirection layer is involved.
  await new Promise((resolve) => { setImmediate(resolve); });
  expect(calls).toBe(2);
});

test('stop clears the scheduled interval', async () => {
  let cleared = null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-'));
  const runner = createCheckRunner({
    checkStore: { listChecks: async () => [chk()], getCheck: async () => chk() },
    dispatcher: createCheckDispatcher({ runners: { http: async () => ({ ok: true, detail: '', latencyMs: 1 }) } }),
    eventLog: createEventLog({ dir, prefix: 'checks', now: () => 1000 }),
    now: () => 1000, jitter: () => 0,
    setIntervalFn: () => 99, clearIntervalFn: (id) => { cleared = id; },
  });
  await runner.start();
  runner.stop();
  expect(cleared).toBe(99);
});
