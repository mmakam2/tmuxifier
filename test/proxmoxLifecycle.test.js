import { test, expect } from 'vitest';
import { createProxmoxLifecycleManager } from '../src/server/proxmoxLifecycle.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const BOX = { id: 'B1', label: 'dev-01', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, endpoint: HOST.endpoint } };

function fixture(initialState = 'stopped', overrides = {}) {
  let state = initialState;
  const calls = [];
  const client = {
    startLxc: async () => { calls.push('start'); state = 'running'; return 'UPID:start'; },
    shutdownLxc: async () => { calls.push('shutdown'); state = 'stopped'; return 'UPID:shutdown'; },
    stopLxc: async () => { calls.push('stop'); state = 'stopped'; return 'UPID:stop'; },
    rebootLxc: async () => { calls.push('reboot'); state = 'running'; return 'UPID:reboot'; },
    taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
    taskLog: async () => [{ n: 1, t: 'task output' }],
  };
  const manager = createProxmoxLifecycleManager({
    boxStore: { getBox: async (id) => id === 'B1' ? BOX : undefined },
    proxmoxStore: { getHost: async () => HOST },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131 }) },
    makeClient: () => client,
    load: () => [], save: () => {}, sleep: async () => {}, pollMs: 0,
    now: () => '2026-07-11T00:00:00.000Z', makeId: () => 'J1',
    removeLinkedBox: async () => {}, shutdownTimeoutMs: 600_000,
    ...overrides,
  });
  return { manager, calls, getState: () => state };
}

test.each([
  ['start', 'stopped', 'running'],
  ['shutdown', 'running', 'stopped'],
  ['stop', 'running', 'stopped'],
  ['reboot', 'running', 'running'],
])('%s creates, polls, verifies, and persists a terminal job', async (action, initial, final) => {
  const { manager, calls, getState } = fixture(initial);
  const summary = await manager.createJob({ boxId: 'B1', action });
  expect(summary).toMatchObject({ id: 'J1', action, status: 'running', boxId: 'B1', vmid: 131 });
  await manager._settled(summary.id);
  expect(manager.getJob(summary.id)).toMatchObject({ status: 'done', phase: 'done', error: null });
  expect(calls).toContain(action);
  expect(getState()).toBe(final);
});

test.each([
  ['start', 'running'], ['shutdown', 'stopped'], ['stop', 'stopped'], ['reboot', 'stopped'],
])('%s rejects invalid %s transition before creating a job', async (action, state) => {
  const { manager } = fixture(state);
  await expect(manager.createJob({ boxId: 'B1', action })).rejects.toMatchObject({ statusCode: 409 });
  expect(manager.listJobs()).toEqual([]);
});

test('unknown PVE state is a preflight gateway failure and target coordinates are rejected', async () => {
  const { manager } = fixture('unknown');
  await expect(manager.createJob({ boxId: 'B1', action: 'start' })).rejects.toMatchObject({ statusCode: 502 });
  await expect(manager.createJob({ boxId: 'B1', action: 'start', vmid: 999 })).rejects.toMatchObject({ statusCode: 400 });
  expect(manager.listJobs()).toEqual([]);
});

test('one active target rejects a concurrent lifecycle job', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let state = 'stopped';
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      startLxc: async () => { state = 'running'; return 'UPID:start'; },
      taskStatus: async () => { await gate; return { status: 'stopped', exitstatus: 'OK' }; },
      taskLog: async () => [],
    }),
  });
  const first = await manager.createJob({ boxId: 'B1', action: 'start' });
  await expect(manager.createJob({ boxId: 'B1', action: 'start' })).rejects.toMatchObject({ statusCode: 409 });
  release();
  await manager._settled(first.id);
});

test('overlapping createJob calls admit only one job per target', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let state = 'stopped';
  let nextId = 0;
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => { await gate; return { boxId: 'B1', state, node: 'pve', vmid: 131 }; } },
    makeClient: () => ({
      startLxc: async () => { state = 'running'; return 'UPID:start'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    makeId: () => `J${++nextId}`,
  });
  const attempts = [manager.createJob({ boxId: 'B1', action: 'start' }), manager.createJob({ boxId: 'B1', action: 'start' })];
  release();
  const results = await Promise.allSettled(attempts);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toMatchObject({ statusCode: 409 });
  expect(manager.listJobs().filter((job) => job.status === 'running')).toHaveLength(1);
  await manager._settled(fulfilled[0].value.id);
});

test('task failure is terminal immediately and task logs stay bounded', async () => {
  const { manager } = fixture('stopped', {
    makeClient: () => ({
      startLxc: async () => 'UPID:start',
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'permission denied' }),
      taskLog: async () => [{ n: 1, t: '0123456789abcdef' }],
    }),
    maxLogBytes: 12,
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'error', error: 'task failed: permission denied' });
  expect(manager.getJob(job.id).log.length).toBeLessThanOrEqual(12);
});

test('task polling tolerates a transient status failure', async () => {
  let state = 'stopped';
  let attempts = 0;
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      startLxc: async () => { state = 'running'; return 'UPID:start'; },
      taskStatus: async () => { if (++attempts === 1) throw new Error('pveproxy restart'); return { status: 'stopped', exitstatus: 'OK' }; },
      taskLog: async () => [],
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(attempts).toBe(2);
});

test('routine action revalidates the stored target before mutating PVE', async () => {
  let reads = 0;
  const calls = [];
  const { manager } = fixture('stopped', {
    boxStore: { getBox: async () => ++reads === 1 ? BOX : { ...BOX, proxmox: { ...BOX.proxmox, vmid: 999 } } },
    makeClient: () => ({ startLxc: async () => calls.push('start') }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('error');
  expect(calls).toEqual([]);
});

test('startup retention keeps only the newest bounded terminal history', () => {
  const { manager } = fixture('running', {
    maxJobs: 2,
    load: () => [
      { id: 'old', action: 'reboot', status: 'done', createdAt: '2026-07-09T00:00:00Z' },
      { id: 'mid', action: 'reboot', status: 'done', createdAt: '2026-07-10T00:00:00Z' },
      { id: 'new', action: 'reboot', status: 'done', createdAt: '2026-07-11T00:00:00Z' },
    ],
  });
  expect(manager.listJobs().map((job) => job.id)).toEqual(['new', 'mid']);
});

test('startup reconciliation interrupts running jobs without replaying them', () => {
  const saved = [];
  const { manager } = fixture('running', {
    load: () => [{ id: 'old', action: 'reboot', status: 'running', phase: 'request', createdAt: 'x' }],
    save: (jobs) => saved.push(jobs),
  });
  expect(manager.getJob('old').status).toBe('interrupted');
  expect(saved[0][0].status).toBe('interrupted');
});

test('deprovision running container gracefully shuts down, destroys, verifies missing, then removes box', async () => {
  let state = 'running';
  const calls = [];
  const { manager } = fixture('running', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      shutdownLxc: async () => { calls.push('shutdown'); state = 'stopped'; return 'UPID:shutdown'; },
      destroyLxc: async () => { calls.push('destroy'); state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    removeLinkedBox: async (id) => calls.push(`remove:${id}`),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(calls).toEqual(['shutdown', 'destroy', 'remove:B1']);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'done', phase: 'done' });
});

test('deprovision already-stopped skips shutdown', async () => {
  let state = 'stopped';
  const calls = [];
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      destroyLxc: async () => { calls.push('destroy'); state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    removeLinkedBox: async (id) => calls.push(`remove:${id}`),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(calls).not.toContain('shutdown');
  expect(calls).toEqual(['destroy', 'remove:B1']);
});

test('deprovision shutdown failure never escalates to stop or removes the box', async () => {
  const calls = [];
  const { manager } = fixture('running', {
    makeClient: () => ({
      shutdownLxc: async () => { calls.push('shutdown'); throw new Error('guest did not stop'); },
      stopLxc: async () => calls.push('stop'), destroyLxc: async () => calls.push('destroy'),
    }),
    removeLinkedBox: async () => calls.push('remove'),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('error');
  expect(calls).toEqual(['shutdown']);
});

test('missing-container deprovision performs typed-confirmation local cleanup only', async () => {
  const removed = [];
  const { manager } = fixture('missing', { removeLinkedBox: async (id) => removed.push(id) });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(removed).toEqual(['B1']);
  expect(manager.getJob(job.id).status).toBe('done');
});

test('confirmation mismatch creates no destructive job', async () => {
  const { manager } = fixture('stopped');
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'wrong' }))
    .rejects.toMatchObject({ statusCode: 409 });
  expect(manager.listJobs()).toEqual([]);
});

test('destroy failure preserves the linked box', async () => {
  const calls = [];
  const { manager } = fixture('stopped', {
    makeClient: () => ({ destroyLxc: async () => { calls.push('destroy'); throw new Error('storage busy'); } }),
    removeLinkedBox: async () => calls.push('remove'),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'error', error: 'storage busy' });
  expect(calls).toEqual(['destroy']);
});

test('graceful task timeout never calls force stop, destroy, or local removal', async () => {
  const calls = [];
  const { manager } = fixture('running', {
    makeClient: () => ({
      shutdownLxc: async () => { calls.push('shutdown'); return 'UPID:shutdown'; },
      taskStatus: async () => ({ status: 'running' }),
      taskLog: async () => [],
      stopLxc: async () => calls.push('stop'),
      destroyLxc: async () => calls.push('destroy'),
    }),
    removeLinkedBox: async () => calls.push('remove'),
    taskTimeoutMs: -1,
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('error');
  expect(calls).toEqual(['shutdown']);
});

test('createJob after an unfollowed migration snapshots the drift-followed node and still runs', async () => {
  // Stored link says pve (stale); the cluster-backed inventory reports pve2 and
  // its pre-check drift write moves the store link — this job does not exist yet,
  // so nothing guards that write. The job must snapshot pve2 or resolveTarget
  // aborts the first lifecycle action after a migration with "link changed".
  let storedBox = BOX; // proxmox.node: 'pve'
  let state = 'stopped';
  const nodesUsed = [];
  const { manager } = fixture('stopped', {
    boxStore: { getBox: async (id) => id === 'B1' ? storedBox : undefined },
    inventory: {
      refreshBox: async (box) => {
        if (box.proxmox.node !== 'pve2') {
          // mimic the inventory's drift write (unguarded: no job registered yet)
          storedBox = { ...storedBox, proxmox: { ...storedBox.proxmox, node: 'pve2' } };
        }
        return { boxId: 'B1', state, node: 'pve2', vmid: 131 };
      },
    },
    makeClient: () => ({
      startLxc: async (node) => { nodesUsed.push(node); state = 'running'; return 'UPID:start'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  expect(job.node).toBe('pve2');
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'done', phase: 'done', error: null });
  expect(nodesUsed).toEqual(['pve2']);
});

test('overlapping createJob calls after a migration still admit only one job per container', async () => {
  // Both callers read the stale pve link, then the drift-followed jobs land on
  // pve2 — the post-await idle re-check must assert on the key the job actually
  // occupies, or both jobs would run against the same container.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let storedBox = BOX; // proxmox.node: 'pve'
  let state = 'stopped';
  let nextId = 0;
  const { manager } = fixture('stopped', {
    boxStore: { getBox: async (id) => id === 'B1' ? storedBox : undefined },
    inventory: { refreshBox: async () => {
      await gate;
      storedBox = { ...storedBox, proxmox: { ...storedBox.proxmox, node: 'pve2' } }; // the drift write
      return { boxId: 'B1', state, node: 'pve2', vmid: 131 };
    } },
    makeClient: () => ({
      startLxc: async () => { state = 'running'; return 'UPID:start'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    makeId: () => `J${++nextId}`,
  });
  const attempts = [manager.createJob({ boxId: 'B1', action: 'start' }), manager.createJob({ boxId: 'B1', action: 'start' })];
  release();
  const results = await Promise.allSettled(attempts);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0].reason).toMatchObject({ statusCode: 409 });
  expect(manager.listJobs().filter((job) => job.status === 'running')).toHaveLength(1);
  await manager._settled(fulfilled[0].value.id);
});

test('failed local cleanup can be retried through the missing-container path', async () => {
  let attempts = 0;
  let sequence = 0;
  const { manager } = fixture('missing', {
    makeId: () => `J${++sequence}`,
    removeLinkedBox: async () => { attempts += 1; if (attempts === 1) throw new Error('disk write failed'); },
  });
  const first = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(first.id);
  expect(manager.getJob(first.id).status).toBe('error');
  const retry = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(retry.id);
  expect(manager.getJob(retry.id).status).toBe('done');
  expect(attempts).toBe(2);
});
