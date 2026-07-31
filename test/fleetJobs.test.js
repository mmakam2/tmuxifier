import { test, expect } from 'vitest';
import {
  partitionJobs, jobLamp, jobReadout, jobClock, runningCount, sameJobShape,
} from '../src/web/fleetJobs.ts';

const T0 = Date.parse('2026-07-31T12:00:00Z');

function job(over = {}) {
  return {
    id: 'j1', command: 'uptime', status: 'done',
    createdAt: new Date(T0 - 60_000).toISOString(),
    startedAt: new Date(T0 - 60_000).toISOString(),
    finishedAt: new Date(T0 - 30_000).toISOString(),
    targetCount: 12, okCount: 12, errorCount: 0, scriptName: null,
    ...over,
  };
}

// --- partitionJobs ---------------------------------------------------------

test('partitionJobs splits running jobs out of the archive, preserving order', () => {
  const jobs = [
    job({ id: 'a', status: 'done' }),
    job({ id: 'b', status: 'running', finishedAt: null }),
    job({ id: 'c', status: 'cancelled' }),
    job({ id: 'd', status: 'running', finishedAt: null }),
  ];
  const { active, history } = partitionJobs(jobs);
  expect(active.map((j) => j.id)).toEqual(['b', 'd']);
  expect(history.map((j) => j.id)).toEqual(['a', 'c', 'd'].filter((x) => x !== 'd'));
  expect(history.map((j) => j.id)).toEqual(['a', 'c']);
});

test('partitionJobs returns empty sections rather than null, so callers never branch on absence', () => {
  expect(partitionJobs([])).toEqual({ active: [], history: [] });
  const allRunning = partitionJobs([job({ status: 'running' })]);
  expect(allRunning.active).toHaveLength(1);
  expect(allRunning.history).toHaveLength(0);
});

test('runningCount counts only running jobs', () => {
  expect(runningCount([job(), job({ status: 'running' }), job({ status: 'running' })])).toBe(2);
  expect(runningCount([])).toBe(0);
});

// --- jobLamp ---------------------------------------------------------------
// The lamp is the row's primary state signal, so every job status must map to
// exactly one LED. 'running' outranks errors: a job still going is a live
// process first and a partial failure second.

test('jobLamp maps every job status to an LED', () => {
  expect(jobLamp(job({ status: 'running' }))).toBe('running');
  expect(jobLamp(job({ status: 'running', errorCount: 3 }))).toBe('running');
  expect(jobLamp(job({ status: 'done', errorCount: 0 }))).toBe('ok');
  expect(jobLamp(job({ status: 'done', errorCount: 1 }))).toBe('error');
  expect(jobLamp(job({ status: 'cancelled' }))).toBe('idle');
  expect(jobLamp(job({ status: 'interrupted' }))).toBe('idle');
});

test('jobLamp reports an errored cancelled job as an error, not merely idle', () => {
  expect(jobLamp(job({ status: 'cancelled', errorCount: 2 }))).toBe('error');
});

// --- jobReadout ------------------------------------------------------------
// The old meta line was `${okCount}/${targetCount} ok · ${status}`, which
// rendered "3/12 ok" identically for 3 ok + 9 failed and 3 ok + 9 still
// pending. errorCount was on the summary the whole time and was discarded.

test('jobReadout names the outstanding targets on a running job', () => {
  const segs = jobReadout(job({ status: 'running', okCount: 4, errorCount: 1, targetCount: 12 }));
  expect(segs).toEqual([
    { text: '4 OK', tone: 'ok' },
    { text: '1 ERR', tone: 'err' },
    { text: '7 RUN', tone: 'run' },
  ]);
});

test('jobReadout distinguishes failures from work still outstanding', () => {
  const failed = jobReadout(job({ status: 'done', okCount: 3, errorCount: 9, targetCount: 12 }));
  const pending = jobReadout(job({ status: 'running', okCount: 3, errorCount: 0, targetCount: 12 }));
  expect(failed).not.toEqual(pending);
  expect(failed.map((s) => s.text)).toEqual(['3 OK', '9 ERR']);
  expect(pending.map((s) => s.text)).toEqual(['3 OK', '9 RUN']);
});

test('jobReadout drops a zero error count but always states the ok count', () => {
  expect(jobReadout(job({ okCount: 12, errorCount: 0 })).map((s) => s.text)).toEqual(['12 OK']);
  expect(jobReadout(job({ okCount: 0, errorCount: 0, status: 'running', targetCount: 12 })).map((s) => s.text))
    .toEqual(['0 OK', '12 RUN']);
});

test('jobReadout names a non-done terminal status, which no count can convey', () => {
  expect(jobReadout(job({ status: 'cancelled', okCount: 9, errorCount: 0, targetCount: 12 })).map((s) => s.text))
    .toEqual(['9 OK', 'CANCELLED']);
  expect(jobReadout(job({ status: 'interrupted', okCount: 7, errorCount: 1, targetCount: 12 })).map((s) => s.text))
    .toEqual(['7 OK', '1 ERR', 'INTERRUPTED']);
});

test('jobReadout never emits a negative outstanding count when the server over-reports', () => {
  const segs = jobReadout(job({ status: 'running', okCount: 12, errorCount: 4, targetCount: 12 }));
  expect(segs.map((s) => s.text)).toEqual(['12 OK', '4 ERR']);
});

// --- jobClock --------------------------------------------------------------
// A running job shows elapsed time (it counts up, which is itself the signal
// that the row is alive); a finished job shows how long ago it landed.

test('jobClock counts up while a job runs', () => {
  const j = job({ status: 'running', finishedAt: null, startedAt: new Date(T0 - 42_000).toISOString() });
  expect(jobClock(j, T0)).toBe('0:42');
  expect(jobClock(j, T0 + 89_000)).toBe('2:11');
});

test('jobClock rolls into hours past sixty minutes', () => {
  const j = job({ status: 'running', finishedAt: null, startedAt: new Date(T0 - 3_862_000).toISOString() });
  expect(jobClock(j, T0)).toBe('1:04:22');
});

test('jobClock shows a settled job as relative to its finish', () => {
  expect(jobClock(job({ finishedAt: new Date(T0 - 240_000).toISOString() }), T0)).toBe('4m ago');
  expect(jobClock(job({ finishedAt: new Date(T0 - 7_200_000).toISOString() }), T0)).toBe('2h ago');
});

test('jobClock falls back to createdAt when a job never recorded a finish', () => {
  const j = job({ status: 'interrupted', finishedAt: null, createdAt: new Date(T0 - 3_600_000).toISOString() });
  expect(jobClock(j, T0)).toBe('1h ago');
});

test('jobClock tolerates a missing or unparseable timestamp instead of rendering NaN', () => {
  expect(jobClock(job({ status: 'running', startedAt: null, finishedAt: null, createdAt: null }), T0)).toBe('');
  expect(jobClock(job({ finishedAt: 'not a date', createdAt: null }), T0)).toBe('');
  // An unparseable finish still falls back to createdAt — a job that ran is
  // better placed roughly than dropped off the timeline entirely.
  expect(jobClock(job({ finishedAt: 'not a date' }), T0)).toBe('1m ago');
});

test('jobClock clamps a clock skew that puts the start in the future', () => {
  const j = job({ status: 'running', finishedAt: null, startedAt: new Date(T0 + 5_000).toISOString() });
  expect(jobClock(j, T0)).toBe('0:00');
});

// --- sameJobShape ----------------------------------------------------------
// The list updates in place so keyboard focus and hover survive a poll. A row
// is only rebuilt when something it actually renders changed.

test('sameJobShape ignores fields the row does not render', () => {
  const a = job();
  expect(sameJobShape(a, { ...a, command: a.command, concurrency: 99 })).toBe(true);
});

test('sameJobShape reports a changed count, status, or name', () => {
  const a = job({ status: 'running', okCount: 4 });
  expect(sameJobShape(a, { ...a, okCount: 5 })).toBe(false);
  expect(sameJobShape(a, { ...a, status: 'done' })).toBe(false);
  expect(sameJobShape(a, { ...a, errorCount: 1 })).toBe(false);
  expect(sameJobShape(a, { ...a, scriptName: 'Nightly patch' })).toBe(false);
});

test('sameJobShape treats a running job as always changed, because its clock ticks', () => {
  const a = job({ status: 'running' });
  expect(sameJobShape(a, { ...a })).toBe(false);
  const done = job({ status: 'done' });
  expect(sameJobShape(done, { ...done })).toBe(true);
});
