import { test, expect } from 'vitest';
import { createFleetManager } from '../src/server/fleet.js';

function makeStore(boxes) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  return { getBox: async (id) => byId.get(id) };
}
const BOXES = [
  { id: 'b1', label: 'web-01', host: 'h1', user: 'me' },
  { id: 'b2', label: 'web-02', host: 'h2', user: 'me' },
];

test('runs the command on every target and captures output + exit code', async () => {
  const seen = [];
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    execCommand: async (box, command) => { seen.push([box.id, command]); return { code: 0, stdout: `out-${box.id}`, stderr: '' }; },
  });
  const job = await mgr.createJob({ boxIds: ['b1', 'b2'], command: 'uptime' });
  expect(job.status).toBe('running');
  expect(job.targets.map((t) => t.status)).toEqual(['pending', 'pending']);
  await mgr._settled(job.id);
  expect(job.status).toBe('done');
  expect(seen).toEqual([['b1', 'uptime'], ['b2', 'uptime']]);
  expect(job.targets[0]).toMatchObject({ boxId: 'b1', label: 'web-01', host: 'h1', status: 'ok', code: 0, stdout: 'out-b1' });
  expect(job.targets[1]).toMatchObject({ status: 'ok', code: 0, stdout: 'out-b2' });
});

test('a non-zero exit and a thrown exec both become error targets; job still completes', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    execCommand: async (box) => {
      if (box.id === 'b1') return { code: 7, stdout: '', stderr: 'boom' };
      throw new Error('ssh exploded');
    },
  });
  const job = await mgr.createJob({ boxIds: ['b1', 'b2'], command: 'x' });
  await mgr._settled(job.id);
  expect(job.status).toBe('done');
  expect(job.targets[0]).toMatchObject({ status: 'error', code: 7, stderr: 'boom' });
  expect(job.targets[1]).toMatchObject({ status: 'error', code: null, error: 'ssh exploded' });
});

test('output beyond maxOutputBytes is clipped and flagged truncated', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    maxOutputBytes: 4,
    execCommand: async () => ({ code: 0, stdout: 'abcdefgh', stderr: '' }),
  });
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'x' });
  await mgr._settled(job.id);
  expect(job.targets[0].stdout).toBe('abcd');
  expect(job.targets[0].truncated).toBe(true);
});

test('fan-out respects the concurrency limit', async () => {
  let inFlight = 0; let peak = 0;
  const mgr = createFleetManager({
    store: makeStore([...Array(6)].map((_, i) => ({ id: `b${i}`, label: `n${i}`, host: `h${i}` }))),
    concurrency: 2,
    execCommand: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--; return { code: 0, stdout: '', stderr: '' };
    },
  });
  const job = await mgr.createJob({ boxIds: ['b0','b1','b2','b3','b4','b5'], command: 'x' });
  await mgr._settled(job.id);
  expect(peak).toBeGreaterThan(0);
  expect(peak).toBeLessThanOrEqual(2);
});

test('createJob rejects an empty command and an unknown boxId', async () => {
  const mgr = createFleetManager({ store: makeStore(BOXES), execCommand: async () => ({ code: 0 }) });
  await expect(mgr.createJob({ boxIds: ['b1'], command: '   ' })).rejects.toThrow(/command/i);
  await expect(mgr.createJob({ boxIds: ['nope'], command: 'x' })).rejects.toThrow(/unknown box/i);
});

test('save is called at create and again after the run finishes; jobs persist', async () => {
  const saves = [];
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    save: (jobs) => saves.push(jobs.map((j) => j.status)),
    execCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'x' });
  await mgr._settled(job.id);
  expect(saves[0]).toEqual(['running']);      // persisted on create
  expect(saves[saves.length - 1]).toEqual(['done']); // persisted on finish
});

test('listJobs returns newest-first summaries with counts; prunes to maxJobs', async () => {
  const mgr = createFleetManager({
    store: makeStore(BOXES),
    maxJobs: 2,
    execCommand: async (box) => (box.id === 'b1' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }),
  });
  const j1 = await mgr.createJob({ boxIds: ['b1', 'b2'], command: 'a' }); await mgr._settled(j1.id);
  const j2 = await mgr.createJob({ boxIds: ['b2'], command: 'b' }); await mgr._settled(j2.id);
  const j3 = await mgr.createJob({ boxIds: ['b2'], command: 'c' }); await mgr._settled(j3.id);
  const list = mgr.listJobs();
  expect(list.map((s) => s.command)).toEqual(['c', 'b']); // newest-first, oldest (a) pruned
  expect(mgr.getJob(j1.id)).toBeUndefined();
  const summaryA = list.find((s) => s.command === 'b');
  expect(summaryA).toMatchObject({ targetCount: 1, okCount: 1, errorCount: 0 });
});

test('cancelJob stops queued targets; in-flight finishes; job ends cancelled', async () => {
  let release0;
  const block0 = new Promise((r) => { release0 = r; });
  let calls = 0;
  const mgr = createFleetManager({
    store: makeStore([
      { id: 'b1', label: 'n1', host: 'h1' },
      { id: 'b2', label: 'n2', host: 'h2' },
      { id: 'b3', label: 'n3', host: 'h3' },
    ]),
    concurrency: 1, // strictly sequential so b2/b3 are still queued when we cancel
    execCommand: async () => { calls++; if (calls === 1) await block0; return { code: 0, stdout: '', stderr: '' }; },
  });
  const job = await mgr.createJob({ boxIds: ['b1', 'b2', 'b3'], command: 'x' }); // b1 in-flight, blocked
  mgr.cancelJob(job.id);  // request cancel while b1 is still running
  release0();             // let b1 complete; b2/b3 see the flag and are skipped
  await mgr._settled(job.id);
  expect(job.status).toBe('cancelled');
  expect(job.targets[0].status).toBe('ok');
  expect(job.targets[1].status).toBe('cancelled');
  expect(job.targets[2].status).toBe('cancelled');
  expect(calls).toBe(1); // b2/b3 never invoked execCommand
});

test('cancelJob returns undefined for an unknown id and is a no-op on a finished job', async () => {
  const mgr = createFleetManager({ store: makeStore(BOXES), execCommand: async () => ({ code: 0, stdout: '', stderr: '' }) });
  expect(mgr.cancelJob('nope')).toBeUndefined();
  const job = await mgr.createJob({ boxIds: ['b1'], command: 'x' });
  await mgr._settled(job.id);
  expect(mgr.cancelJob(job.id).status).toBe('done'); // already finished — unchanged
});
