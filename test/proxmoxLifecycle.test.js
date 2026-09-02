import { test, expect } from 'vitest';
import { createProxmoxLifecycleManager } from '../src/server/proxmoxLifecycle.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const BOX = { id: 'B1', label: 'dev-01', host: '192.168.1.10', proxmox: { hostId: 'H1', node: 'pve', vmid: 131, kind: 'lxc', endpoint: HOST.endpoint } };

function fixture(initialState = 'stopped', overrides = {}) {
  let state = initialState;
  const calls = [];
  const client = {
    startGuest: async (kind) => { calls.push(`start:${kind}`); state = 'running'; return 'UPID:start'; },
    shutdownGuest: async (kind, node, vmid, opts) => { calls.push(`shutdown:${kind}`, opts); state = 'stopped'; return 'UPID:shutdown'; },
    stopGuest: async (kind) => { calls.push(`stop:${kind}`); state = 'stopped'; return 'UPID:stop'; },
    rebootGuest: async (kind) => { calls.push(`reboot:${kind}`); state = 'running'; return 'UPID:reboot'; },
    taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
    taskLog: async () => [{ n: 1, t: 'task output' }],
  };
  const manager = createProxmoxLifecycleManager({
    boxStore: { getBox: async (id) => id === 'B1' ? BOX : undefined },
    proxmoxStore: { getHost: async () => HOST },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131, kind: 'lxc' }) },
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
  expect(calls).toContain(`${action}:lxc`);
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
      startGuest: async () => { state = 'running'; return 'UPID:start'; },
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
      startGuest: async () => { state = 'running'; return 'UPID:start'; },
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
      startGuest: async () => 'UPID:start',
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
      startGuest: async () => { state = 'running'; return 'UPID:start'; },
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
    makeClient: () => ({ startGuest: async () => calls.push('start') }),
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
      shutdownGuest: async () => { calls.push('shutdown'); state = 'stopped'; return 'UPID:shutdown'; },
      destroyGuest: async () => { calls.push('destroy'); state = 'missing'; return 'UPID:destroy'; },
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
      destroyGuest: async () => { calls.push('destroy'); state = 'missing'; return 'UPID:destroy'; },
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
      shutdownGuest: async () => { calls.push('shutdown'); throw new Error('guest did not stop'); },
      stopGuest: async () => calls.push('stop'), destroyGuest: async () => calls.push('destroy'),
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
    makeClient: () => ({ destroyGuest: async () => { calls.push('destroy'); throw new Error('storage busy'); } }),
    removeLinkedBox: async () => calls.push('remove'),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'error', error: 'storage busy' });
  expect(calls).toEqual(['destroy']);
});

test('deprovision forgets the box host key after destroying the container', async () => {
  let state = 'stopped';
  const calls = [];
  const forgets = [];
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      destroyGuest: async () => { calls.push('destroy'); state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    removeLinkedBox: async (id) => calls.push(`remove:${id}`),
    knownHosts: { forget: async (host, port) => { forgets.push([host, port]); return []; } },
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(calls).toEqual(['destroy', 'remove:B1']);
  expect(forgets).toEqual([['192.168.1.10', undefined]]);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'done', phase: 'done' });
});

test('missing-container deprovision also forgets the box host key', async () => {
  const removed = [];
  const forgets = [];
  const { manager } = fixture('missing', {
    removeLinkedBox: async (id) => removed.push(id),
    knownHosts: { forget: async (host, port) => { forgets.push([host, port]); return []; } },
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(removed).toEqual(['B1']);
  expect(forgets).toEqual([['192.168.1.10', undefined]]);
  expect(manager.getJob(job.id).status).toBe('done');
});

test('deprovision succeeds even when forgetting the host key rejects', async () => {
  let state = 'stopped';
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      destroyGuest: async () => { state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    knownHosts: { forget: async () => { throw new Error('ssh-keygen missing'); } },
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
});

test('graceful task timeout never calls force stop, destroy, or local removal', async () => {
  const calls = [];
  const { manager } = fixture('running', {
    makeClient: () => ({
      shutdownGuest: async () => { calls.push('shutdown'); return 'UPID:shutdown'; },
      taskStatus: async () => ({ status: 'running' }),
      taskLog: async () => [],
      stopGuest: async () => calls.push('stop'),
      destroyGuest: async () => calls.push('destroy'),
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
      startGuest: async (kind, node) => { nodesUsed.push(node); state = 'running'; return 'UPID:start'; },
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
      startGuest: async () => { state = 'running'; return 'UPID:start'; },
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

const nbSettings = { url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 't' };
const BOX_WITH_IP = { ...BOX, proxmox: { ...BOX.proxmox, netboxIpId: 99 } };

test('deprovision releases the NetBox IP after destroy and logs it', async () => {
  let state = 'running';
  const released = [];
  const { manager } = fixture('running', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      shutdownGuest: async () => { state = 'stopped'; return 'UPID:shutdown'; },
      destroyGuest: async () => { state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({ findIpsByAddress: async () => [], releaseIp: async (id) => { released.push(id); } }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const done = manager.getJob(job.id);
  expect(done.status).toBe('done');
  expect(released).toEqual([99]);
  expect(done.log).toContain('released NetBox ip 99');
});

test('deprovision without a netboxIpId or without NetBox configured skips the release silently', async () => {
  let touched = 0;
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => null },
    makeNetboxClient: () => { touched += 1; return {}; },
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(touched).toBe(0);
  expect(manager.getJob(job.id).log).not.toContain('NetBox');
});

test('a failing release never fails the deprovision job', async () => {
  let state = 'running';
  const { manager } = fixture('running', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    inventory: { refreshBox: async () => ({ state, node: 'pve', vmid: 131 }) },
    makeClient: () => ({
      shutdownGuest: async () => { state = 'stopped'; return 'UPID:shutdown'; },
      destroyGuest: async () => { state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({ findIpsByAddress: async () => [], releaseIp: async () => { throw new Error('netbox down'); } }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(manager.getJob(job.id).log).toContain('could not release NetBox ip 99: netbox down');
});

test('missing-container deprovision also releases the NetBox IP', async () => {
  const removed = [];
  const released = [];
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    removeLinkedBox: async (id) => removed.push(id),
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({ findIpsByAddress: async () => [], releaseIp: async (id) => { released.push(id); } }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(removed).toEqual(['B1']);
  expect(released).toEqual([99]);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(manager.getJob(job.id).log).toContain('released NetBox ip 99');
});

test('deprovision of a manually linked box deletes the NetBox record matching its current IP', async () => {
  const lookups = [];
  const released = [];
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async (ip) => { lookups.push(ip); return [{ id: 42, address: '192.168.1.10/24' }]; },
      releaseIp: async (id) => { released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const done = manager.getJob(job.id);
  expect(done.status).toBe('done');
  expect(lookups).toEqual(['192.168.1.10']);
  expect(released).toEqual([42]);
  expect(done.log).toContain('released NetBox ip 42 (192.168.1.10/24)');
});

test('every record matching the current IP is deleted; one failure does not stop the rest', async () => {
  const released = [];
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => [
        { id: 42, address: '192.168.1.10/24' },
        { id: 43, address: '192.168.1.10/32' },
        { id: 44, address: '192.168.1.10/25' },
      ],
      releaseIp: async (id) => { if (id === 43) throw new Error('locked'); released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const done = manager.getJob(job.id);
  expect(done.status).toBe('done');
  expect(released).toEqual([42, 44]);
  expect(done.log).toContain('could not release NetBox ip 43 (192.168.1.10/32): locked');
  expect(done.log).toContain('released NetBox ip 44 (192.168.1.10/25)');
});

test('a stamped allocation and a same-IP manual record are both released', async () => {
  const released = [];
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => [{ id: 42, address: '192.168.1.10/32' }],
      releaseIp: async (id) => { released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(released).toEqual([99, 42]);
  const log = manager.getJob(job.id).log;
  expect(log).toContain('released NetBox ip 99');
  expect(log).toContain('released NetBox ip 42 (192.168.1.10/32)');
});

test('no matching record on an unstamped box logs the miss', async () => {
  const released = [];
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => [],
      releaseIp: async (id) => { released.push(id); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(released).toEqual([]);
  expect(manager.getJob(job.id).log).toContain('no NetBox ip record matches 192.168.1.10');
});

test('a stamped release followed by an empty sweep does not log a no-match line', async () => {
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({ findIpsByAddress: async () => [], releaseIp: async () => {} }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const log = manager.getJob(job.id).log;
  expect(log).toContain('released NetBox ip 99');
  expect(log).not.toContain('no NetBox ip record matches');
});

test('a failing IP lookup never fails the deprovision job', async () => {
  const { manager } = fixture('missing', {
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => ({
      findIpsByAddress: async () => { throw new Error('netbox down'); },
      releaseIp: async () => { throw new Error('releaseIp must not run'); },
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(manager.getJob(job.id).log).toContain('could not look up NetBox ip records for 192.168.1.10: netbox down');
});

test('a hostname-hosted box without a stamp never touches NetBox', async () => {
  let touched = 0;
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? { ...BOX, host: 'dev-01.lan' } : undefined },
    netboxStore: { getSettings: async () => nbSettings },
    makeNetboxClient: () => { touched += 1; return {}; },
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id).status).toBe('done');
  expect(touched).toBe(0);
  expect(manager.getJob(job.id).log).not.toContain('NetBox');
});

test('a link with a netboxIpId but no NetBox settings logs the skip instead of failing silently', async () => {
  let touched = 0;
  const { manager } = fixture('missing', {
    boxStore: { getBox: async (id) => id === 'B1' ? BOX_WITH_IP : undefined },
    netboxStore: { getSettings: async () => null },
    makeNetboxClient: () => { touched += 1; return {}; },
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  const done = manager.getJob(job.id);
  expect(done.status).toBe('done');
  expect(done.log).toContain('could not release NetBox ip 99: NetBox integration not configured');
  expect(touched).toBe(0);
});

// --- post-action status fast-track ------------------------------------------
// PVE reporting "running" does not mean the container answers SSH yet, and the
// status snapshot is only refreshed on its own interval — so without this the
// UI keeps showing a just-started box as stopped for up to a full poll cycle
// after it is actually usable.

test('a start job fast-tracks the status poller for that box once PVE reports it running', async () => {
  const tracked = [];
  const { manager } = fixture('stopped', { onContainerUp: (boxId) => { tracked.push(boxId); } });
  const summary = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(summary.id);
  expect(manager.getJob(summary.id)).toMatchObject({ status: 'done' });
  expect(tracked).toEqual(['B1']);
});

test('a reboot job fast-tracks too — the box goes away and comes back', async () => {
  const tracked = [];
  const { manager } = fixture('running', { onContainerUp: (boxId) => { tracked.push(boxId); } });
  const summary = await manager.createJob({ boxId: 'B1', action: 'reboot' });
  await manager._settled(summary.id);
  expect(tracked).toEqual(['B1']);
});

test('actions that leave the container down do not fast-track', async () => {
  for (const action of ['shutdown', 'stop']) {
    const tracked = [];
    const { manager } = fixture('running', { onContainerUp: (boxId) => { tracked.push(boxId); } });
    const summary = await manager.createJob({ boxId: 'B1', action });
    await manager._settled(summary.id);
    expect(tracked).toEqual([]);
  }
});

test('a throwing fast-track never fails the job it rode along with', async () => {
  const { manager } = fixture('stopped', { onContainerUp: () => { throw new Error('poller exploded'); } });
  const summary = await manager.createJob({ boxId: 'B1', action: 'start' });
  await manager._settled(summary.id);
  expect(manager.getJob(summary.id)).toMatchObject({ status: 'done', error: null });
});

// B10 (2026-07-29 review): same missing shape guard as the provision manager —
// `[null]` in proxmox-lifecycle-jobs.json crashed the server at boot.
test('a malformed persisted job row is dropped instead of crashing boot', () => {
  const rows = [null, 'nope', 42, { noId: true }, { id: 'l9', status: 'running', createdAt: 'now' }];
  let manager;
  expect(() => { manager = fixture('stopped', { load: () => rows }).manager; }).not.toThrow();
  const kept = manager.listJobs();
  expect(kept.map((j) => j.id)).toEqual(['l9']);
  expect(kept[0].status).toBe('interrupted'); // still reconciled
});

const VM_BOX = { id: 'B1', label: 'vm-01', host: '192.168.1.20', proxmox: { hostId: 'H1', node: 'pve', vmid: 200, kind: 'qemu', endpoint: HOST.endpoint } };

test.each([
  ['start', 'stopped', 'running'],
  ['shutdown', 'running', 'stopped'],
  ['stop', 'running', 'stopped'],
  ['reboot', 'running', 'running'],
])('%s runs against a qemu guest and records the kind on the job', async (action, initial, final) => {
  let state = initial;
  const { manager, calls } = fixture(initial, {
    boxStore: { getBox: async (id) => id === 'B1' ? VM_BOX : undefined },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 200, kind: 'qemu' }) },
    makeClient: () => ({
      startGuest: async (kind) => { calls.push(`start:${kind}`); state = 'running'; return 'UPID:start'; },
      shutdownGuest: async (kind) => { calls.push(`shutdown:${kind}`); state = 'stopped'; return 'UPID:shutdown'; },
      stopGuest: async (kind) => { calls.push(`stop:${kind}`); state = 'stopped'; return 'UPID:stop'; },
      rebootGuest: async (kind) => { calls.push(`reboot:${kind}`); state = 'running'; return 'UPID:reboot'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
  });
  const summary = await manager.createJob({ boxId: 'B1', action });
  expect(summary).toMatchObject({ action, kind: 'qemu', vmid: 200 });
  await manager._settled(summary.id);
  expect(manager.getJob(summary.id)).toMatchObject({ status: 'done', error: null });
  expect(calls).toContain(`${action}:qemu`);
  expect(state).toBe(final);
});

test('a kind mismatch refuses every action with a message naming the problem', async () => {
  const { manager } = fixture('running', {
    inventory: { refreshBox: async () => ({
      boxId: 'B1', state: 'mismatch', node: 'pve', vmid: 131, kind: 'qemu',
      error: 'vmid 131 is a qemu guest on this cluster, but this box is linked to a lxc — re-link the box',
    }) },
  });
  await expect(manager.createJob({ boxId: 'B1', action: 'shutdown' }))
    .rejects.toMatchObject({ statusCode: 409, message: /re-link the box/ });
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }))
    .rejects.toMatchObject({ statusCode: 409, message: /re-link the box/ });
  expect(manager.listJobs()).toEqual([]);
});

// A template is checked before the deprovision/REQUIRED branches (same spot
// as the mismatch check above), so it refuses deprovision too — destroying a
// template destroys every future clone's source.
test('a template guest refuses every action, including deprovision', async () => {
  const { manager } = fixture('stopped', {
    inventory: { refreshBox: async () => ({
      boxId: 'B1', state: 'stopped', node: 'pve', vmid: 131, kind: 'lxc', template: true,
    }) },
  });
  await expect(manager.createJob({ boxId: 'B1', action: 'start' }))
    .rejects.toMatchObject({ statusCode: 409, message: /template/ });
  await expect(manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' }))
    .rejects.toMatchObject({ statusCode: 409, message: /template/ });
  expect(manager.listJobs()).toEqual([]);
});

test('deprovision hands PVE the grace period and the force-stop flag', async () => {
  let state = 'running';
  const shutdowns = [];
  const calls = [];
  const { manager } = fixture('running', {
    deprovisionGraceSec: 90,
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131, kind: 'lxc' }) },
    makeClient: () => ({
      shutdownGuest: async (kind, node, vmid, opts) => { shutdowns.push([kind, opts]); state = 'stopped'; return 'UPID:shutdown'; },
      stopGuest: async () => { calls.push('stop'); return 'UPID:stop'; },
      destroyGuest: async (kind) => { calls.push(`destroy:${kind}`); state = 'missing'; return 'UPID:destroy'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'deprovision', confirmName: 'dev-01' });
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'done' });
  expect(shutdowns).toEqual([['lxc', { forceStop: true, timeout: 90 }]]);
  // The escalation is PVE's, not ours: we never issue a separate stop.
  expect(calls).toEqual(['destroy:lxc']);
});

test('a job loaded from history without a kind reads as lxc', async () => {
  const { manager } = fixture('stopped', {
    load: () => [{ id: 'OLD', action: 'start', boxId: 'B1', status: 'done', phase: 'done', createdAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', log: '', error: null }],
  });
  expect(manager.listJobs()[0]).toMatchObject({ id: 'OLD', kind: 'lxc' });
});

test("job.kind is pinned to the link, not the refreshed inventory record", async () => {
  // The link says qemu; the refreshed record disagrees and says lxc, while
  // still reporting an ordinary actionable state ('stopped'). Mismatch
  // *detection* is the inventory's job (the 'mismatch' state, covered
  // elsewhere) — this record is a legal input to the manager, which must
  // still dispatch on the link's kind, not the record's. A "tidy" refactor
  // that sourced kind from `current` alongside `node` would dispatch
  // start:lxc here instead and this test would catch it.
  const calls = [];
  let state = 'stopped';
  const { manager } = fixture('stopped', {
    boxStore: { getBox: async (id) => id === 'B1' ? VM_BOX : undefined },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 200, kind: 'lxc' }) },
    makeClient: () => ({
      startGuest: async (kind) => { calls.push(`start:${kind}`); state = 'running'; return 'UPID:start'; },
      taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
      taskLog: async () => [],
    }),
  });
  const job = await manager.createJob({ boxId: 'B1', action: 'start' });
  expect(job.kind).toBe('qemu');
  await manager._settled(job.id);
  expect(manager.getJob(job.id)).toMatchObject({ status: 'done', error: null });
  expect(calls).toEqual(['start:qemu']);
});

// ---------------------------------------------------------------------------
// readdress: move a linked container to a new NetBox-managed VLAN/IP
// ---------------------------------------------------------------------------
const NET0 = 'name=eth0,bridge=vmbr0,firewall=1,gw=192.168.1.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.1.10/24,tag=10,type=veth';
const NET0_AFTER = 'name=eth0,bridge=vmbr0,firewall=1,gw=192.168.30.1,hwaddr=BC:24:11:AA:BB:CC,ip=192.168.30.7/24,tag=30,type=veth';

function readdressFixture(state = 'running', overrides = {}, { net0 = NET0, hostname = 'dev-01', netboxIpId = 99 } = {}) {
  const calls = [];
  const forgets = [];
  let stored = { ...BOX, proxmox: { ...BOX.proxmox, ...(netboxIpId == null ? {} : { netboxIpId }) } };
  const client = {
    guestConfig: async (kind, node, vmid) => { calls.push(`config:${kind}:${node}:${vmid}`); return { hostname, ...(net0 == null ? {} : { net0 }) }; },
    setLxcConfig: async (node, vmid, params) => { calls.push(`set:${node}:${vmid}:${params.net0}`); return null; },
  };
  const netbox = {
    findPrefixByVlan: async (vid) => { calls.push(`prefix:${vid}`); return { id: 7, prefix: '192.168.30.0/24' }; },
    allocateIp: async (prefix, fields) => { calls.push(['allocate', prefix.prefix, fields]); return { id: 120, address: '192.168.30.7/24', gateway: '192.168.30.1' }; },
    findIpsByAddress: async (ip) => { calls.push(`lookup:${ip}`); return []; },
    releaseIp: async (id) => { calls.push(`release:${id}`); },
  };
  const manager = createProxmoxLifecycleManager({
    boxStore: {
      getBox: async (id) => id === 'B1' ? stored : undefined,
      uniquenessConflict: async ({ host }, ignoreId) => { calls.push(`unique:${host}:${ignoreId}`); return null; },
      readdressBox: async (id, { host, netboxIpId: nid }) => { calls.push(`relink:${host}:${nid}`); stored = { ...stored, host, proxmox: { ...stored.proxmox, netboxIpId: nid } }; return stored; },
    },
    proxmoxStore: { getHost: async () => HOST },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state, node: 'pve', vmid: 131, kind: 'lxc' }) },
    makeClient: () => client,
    netboxStore: { getSettings: async () => ({ ...nbSettings, dnsSuffix: 'lan.example.com' }) },
    makeNetboxClient: () => netbox,
    knownHosts: { forget: async (host, port) => { forgets.push([host, port]); return []; } },
    onReaddress: async ({ before, after }) => { calls.push(`hook:${before.host}->${after.host}`); },
    onContainerUp: (boxId) => { calls.push(`up:${boxId}`); },
    load: () => [], save: () => {}, sleep: async () => {}, pollMs: 0,
    now: () => '2026-09-02T00:00:00.000Z', makeId: () => 'J1',
    removeLinkedBox: async () => {},
    ...overrides,
  });
  return { manager, calls, forgets, getStored: () => stored, client, netbox };
}

test('readdress on a running container: inspect, allocate, apply, relink, release old, forget both keys, fire hooks — in that order', async () => {
  const { manager, calls, forgets, getStored } = readdressFixture('running');
  const summary = await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  expect(summary).toMatchObject({ id: 'J1', action: 'readdress', status: 'running', boxId: 'B1', kind: 'lxc' });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({
    status: 'done', phase: 'done', error: null, vlan: 30,
    oldIp: '192.168.1.10/24', oldVlan: 10, oldNetboxIpId: 99, hostname: 'dev-01',
    ip: '192.168.30.7/24', gateway: '192.168.30.1', netboxIpId: 120,
  });
  expect(calls).toEqual([
    'config:lxc:pve:131',
    'prefix:30',
    ['allocate', '192.168.30.0/24', { status: 'active', description: 'tmuxifier: dev-01', dns_name: 'dev-01.lan.example.com' }],
    'unique:192.168.30.7:B1',
    `set:pve:131:${NET0_AFTER}`,
    'relink:192.168.30.7:120',
    'release:99',
    'lookup:192.168.1.10',
    'hook:192.168.1.10->192.168.30.7',
    'up:B1',
  ]);
  expect(forgets).toEqual([['192.168.30.7', undefined], ['192.168.1.10', undefined]]);
  expect(getStored().host).toBe('192.168.30.7');
  expect(job.log).toContain(`# before: ${NET0}`);
  expect(job.log).toContain('allocated 192.168.30.7/24 from 192.168.30.0/24 (gw 192.168.30.1, NetBox ip 120)');
  expect(job.log).toContain('released NetBox ip 99');
});

test('readdress on a stopped container does the same work but never signals container-up', async () => {
  const { manager, calls } = readdressFixture('stopped');
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  expect(manager.getJob('J1').status).toBe('done');
  expect(calls).not.toContain('up:B1');
  expect(calls).toContain('hook:192.168.1.10->192.168.30.7');
});

test('readdress of a dhcp, hand-linked container: no old id, old address swept from the box host', async () => {
  const { manager, calls } = readdressFixture('running', {
    makeNetboxClient: () => ({
      findPrefixByVlan: async () => ({ id: 7, prefix: '192.168.30.0/24' }),
      allocateIp: async () => ({ id: 120, address: '192.168.30.7/24', gateway: '192.168.30.1' }),
      findIpsByAddress: async (ip) => { calls.push(`lookup:${ip}`); return [{ id: 42, address: '192.168.1.10/32' }]; },
      releaseIp: async (id) => { calls.push(`release:${id}`); },
    }),
  }, { net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=dhcp,type=veth', netboxIpId: null });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'done', oldIp: null, oldVlan: null, oldNetboxIpId: null, netboxIpId: 120 });
  expect(calls).toContain('set:pve:131:name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,ip=192.168.30.7/24,type=veth,tag=30,gw=192.168.30.1');
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual(['release:42']);
  expect(calls).toContain('lookup:192.168.1.10');
});

test('readdress uses the box label and no dns_name when the PVE hostname is not a DNS label', async () => {
  const { manager, calls } = readdressFixture('running', {}, { hostname: 'bad_host' });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  expect(calls).toContainEqual(['allocate', '192.168.30.0/24', { status: 'active', description: 'tmuxifier: dev-01' }]);
});

test('readdress refusals create no job: VM link, template, missing state, setup running, bad vlan, vlan on a power action, NetBox unconfigured', async () => {
  const qemu = readdressFixture('running', {
    boxStore: { getBox: async () => ({ ...BOX, proxmox: { ...BOX.proxmox, kind: 'qemu' } }) },
    inventory: { refreshBox: async () => ({ boxId: 'B1', state: 'running', node: 'pve', vmid: 131, kind: 'qemu' }) },
  });
  await expect(qemu.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409, message: /containers only/ });
  const template = readdressFixture('stopped', { inventory: { refreshBox: async () => ({ boxId: 'B1', state: 'stopped', node: 'pve', vmid: 131, kind: 'lxc', template: true }) } });
  await expect(template.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409 });
  const missing = readdressFixture('missing');
  await expect(missing.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409, message: /cannot run from missing/ });
  const setup = readdressFixture('running', { setupRunning: () => true });
  await expect(setup.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 409, message: /setup/ });
  const ok = readdressFixture('running');
  for (const vlan of [undefined, 0, 4095, '30', 30.5]) {
    await expect(ok.manager.createJob({ boxId: 'B1', action: 'readdress', vlan })).rejects.toMatchObject({ statusCode: 400, message: /vlan/ });
  }
  await expect(ok.manager.createJob({ boxId: 'B1', action: 'shutdown', vlan: 30 })).rejects.toMatchObject({ statusCode: 400, message: /vlan/ });
  const noNetbox = readdressFixture('running', { netboxStore: null });
  await expect(noNetbox.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 400, message: /NetBox/ });
  const unconfigured = readdressFixture('running', { netboxStore: { getSettings: async () => null } });
  await expect(unconfigured.manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 })).rejects.toMatchObject({ statusCode: 400, message: /NetBox/ });
  for (const f of [qemu, template, missing, setup, ok, noNetbox, unconfigured]) expect(f.manager.listJobs()).toEqual([]);
});

test('readdress fails before any NetBox call when the container has no net0', async () => {
  const { manager, calls } = readdressFixture('running', {}, { net0: null });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  expect(manager.getJob('J1')).toMatchObject({ status: 'error', phase: 'inspect', error: /net0/ });
  expect(calls).toEqual(['config:lxc:pve:131']);
});

test('a uniqueness conflict on the new address fails the job and releases the fresh allocation, touching neither PVE nor the old record', async () => {
  const { manager, calls, getStored } = readdressFixture('running', {
    boxStore: {
      getBox: async () => ({ ...BOX, proxmox: { ...BOX.proxmox, netboxIpId: 99 } }),
      uniquenessConflict: async () => 'box host already exists',
      readdressBox: async () => { throw new Error('must not be called'); },
    },
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'error', phase: 'allocate-ip', error: /host already exists/, netboxIpId: null });
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('set:'))).toEqual([]);
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual(['release:120']);
  expect(job.log).toContain('released NetBox ip 120 (unused allocation)');
  expect(getStored().host).toBe('192.168.1.10');
});

test('an apply failure releases the fresh allocation and leaves the old record and the box untouched', async () => {
  const { manager, calls, getStored } = readdressFixture('running', {
    makeClient: () => ({
      guestConfig: async () => ({ hostname: 'dev-01', net0: NET0 }),
      setLxcConfig: async () => { throw new Error('hotplug failed'); },
    }),
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'error', phase: 'apply', error: 'hotplug failed', netboxIpId: null });
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual(['release:120']);
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('relink:'))).toEqual([]);
  expect(getStored().host).toBe('192.168.1.10');
});

test('a relink failure after the container moved names both addresses and releases nothing', async () => {
  const { manager, calls } = readdressFixture('running', {
    boxStore: {
      getBox: async () => ({ ...BOX, proxmox: { ...BOX.proxmox, netboxIpId: 99 } }),
      uniquenessConflict: async () => null,
      readdressBox: async () => { throw new Error('disk write failed'); },
    },
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job.status).toBe('error');
  expect(job.phase).toBe('relink');
  expect(job.error).toContain('192.168.30.7');
  expect(job.error).toContain('192.168.1.10');
  expect(job.error).toContain('disk write failed');
  expect(job.netboxIpId).toBe(120);
  expect(calls.filter((c) => typeof c === 'string' && c.startsWith('release:'))).toEqual([]);
});

test('a failing old-record release or a throwing hook never fails a readdress job', async () => {
  const { manager } = readdressFixture('running', {
    makeNetboxClient: () => ({
      findPrefixByVlan: async () => ({ id: 7, prefix: '192.168.30.0/24' }),
      allocateIp: async () => ({ id: 120, address: '192.168.30.7/24', gateway: '192.168.30.1' }),
      findIpsByAddress: async () => { throw new Error('netbox down'); },
      releaseIp: async () => { throw new Error('netbox down'); },
    }),
    onReaddress: async () => { throw new Error('exitMaster exploded'); },
    knownHosts: { forget: async () => { throw new Error('ssh-keygen missing'); } },
  });
  await manager.createJob({ boxId: 'B1', action: 'readdress', vlan: 30 });
  await manager._settled('J1');
  const job = manager.getJob('J1');
  expect(job).toMatchObject({ status: 'done', phase: 'done', netboxIpId: 120 });
  expect(job.log).toContain('could not release NetBox ip 99: netbox down');
});

test('boot reconcile releases an allocation interrupted at allocate-ip and only logs one interrupted at apply or later', async () => {
  const released = [];
  const { manager } = readdressFixture('running', {
    load: () => [
      { id: 'A', action: 'readdress', boxId: 'B1', status: 'running', phase: 'allocate-ip', netboxIpId: 120, log: '', createdAt: '2026-09-01T00:00:00Z' },
      { id: 'B', action: 'readdress', boxId: 'B1', status: 'running', phase: 'apply', netboxIpId: 121, log: '', createdAt: '2026-09-01T00:00:01Z' },
      { id: 'C', action: 'readdress', boxId: 'B1', status: 'running', phase: 'inspect', netboxIpId: null, log: '', createdAt: '2026-09-01T00:00:02Z' },
    ],
    makeNetboxClient: () => ({ releaseIp: async (id) => { released.push(id); } }),
  });
  await manager._reconciled();
  expect(released).toEqual([120]);
  expect(manager.getJob('A')).toMatchObject({ status: 'interrupted', netboxIpId: null });
  expect(manager.getJob('A').log).toContain('released NetBox ip 120');
  expect(manager.getJob('B')).toMatchObject({ status: 'interrupted', netboxIpId: 121 });
  expect(manager.getJob('B').log).toContain('NetBox ip 121 may be in use');
  expect(manager.getJob('C')).toMatchObject({ status: 'interrupted', netboxIpId: null });
});
