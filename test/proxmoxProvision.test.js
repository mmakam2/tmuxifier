import { test, expect } from 'vitest';
import { createProvisionManager } from '../src/server/proxmoxProvision.js';

const PRESET_DHCP = {
  id: 'p1', name: 'dev', hostId: 'h1', node: 'pve', template: 'local:vztmpl/x.tar.zst',
  storage: 'local-lvm', diskGiB: 8, cores: 2, memoryMiB: 2048, swapMiB: 512, unprivileged: true,
  features: {}, net: { bridge: 'vmbr0', ipMode: 'dhcp', cidr: null, gateway: null }, dns: {},
  keyIds: ['k1'], onboot: false, startAfterCreate: true, boxDefaults: { user: 'root', sessionName: 'web', tags: [] },
};
const PRESET_STATIC = { ...PRESET_DHCP, id: 'p2', net: { bridge: 'vmbr0', ipMode: 'static', cidr: '192.168.1.50/24', gateway: '192.168.1.1' } };
const HOST = { id: 'h1', endpoint: 'pve.example.com:8006', tokenId: 'user@pam!t', tokenSecret: 'sek', verifyMode: 'pin', fingerprint256: 'AB' };

function makeStore(preset) {
  return {
    getPreset: async (id) => (id === preset.id ? preset : undefined),
    getHost: async () => HOST,
    listKeys: async () => [{ id: 'k1', publicKey: 'ssh-ed25519 AAA you@example.com' }],
  };
}
function fakeBoxStore() {
  const added = [];
  return { added, addBox: async (spec) => { const b = { id: `box-${added.length + 1}`, ...spec }; added.push(b); return b; } };
}
// A client whose task always succeeds immediately; interfaces configurable.
function okClient({ ifaces = [{ name: 'eth0', inet: '192.168.1.77/24' }] } = {}) {
  return {
    nextId: async () => '131',
    createLxc: async () => 'UPID:create',
    startLxc: async () => 'UPID:start',
    taskStatus: async () => ({ status: 'stopped', exitstatus: 'OK' }),
    taskLog: async () => [{ n: 1, t: 'creating...' }],
    lxcInterfaces: async () => ifaces,
  };
}
const base = (over = {}) => ({
  boxStore: fakeBoxStore(), load: () => [], save: () => {},
  now: () => '2026-06-26T00:00:00Z', makeId: (() => { let n = 0; return () => `job-${++n}`; })(),
  sleep: async () => {}, pollMs: 0, leaseTimeoutMs: 1000, ...over,
});

test('static preset: create -> start -> link box from the static IP', async () => {
  const boxStore = fakeBoxStore();
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), boxStore, makeClient: () => okClient() }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-01' });
  expect(job.status).toBe('running');
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('done');
  expect(done.vmid).toBe(131);
  expect(boxStore.added[0]).toMatchObject({ host: '192.168.1.50', user: 'root', source: 'proxmox', label: 'dev-01' });
  expect(boxStore.added[0].proxmox).toMatchObject({ node: 'pve', vmid: 131, hostId: 'h1' });
  expect(done.boxId).toBe('box-1');
});

test('dhcp preset: discovers the leased IP then links the box', async () => {
  const boxStore = fakeBoxStore();
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), boxStore, makeClient: () => okClient() }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-02' });
  await mgr._settled(job.id);
  expect(boxStore.added[0].host).toBe('192.168.1.77');
  expect(mgr.getProvision(job.id).status).toBe('done');
});

test('dhcp lease timeout: job still succeeds but defers the box', async () => {
  const boxStore = fakeBoxStore();
  const client = okClient({ ifaces: [] }); // never reports an inet
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), boxStore, makeClient: () => client, leaseTimeoutMs: 0 }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-03' });
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('done');
  expect(done.needsHost).toBe(true);
  expect(done.boxId).toBeNull();
  expect(boxStore.added).toHaveLength(0);
});

test('a failed create task marks the job error', async () => {
  const client = { ...okClient(), taskStatus: async () => ({ status: 'stopped', exitstatus: 'volume create failed' }) };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), makeClient: () => client }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-04' });
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('error');
  expect(done.error).toMatch(/volume create failed/);
});

test('cancel before the create task finishes ends the job cancelled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = { ...okClient(), createLxc: async () => { await gate; return 'UPID:create'; } };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), makeClient: () => client }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-05' });
  mgr.cancelProvision(job.id);
  release();
  await mgr._settled(job.id);
  expect(mgr.getProvision(job.id).status).toBe('cancelled');
});

test('task log is capped at maxLogBytes', async () => {
  const client = { ...okClient(), taskLog: async () => [{ n: 1, t: 'x'.repeat(100) }] };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), makeClient: () => client, maxLogBytes: 10 }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-06' });
  await mgr._settled(job.id);
  expect(mgr.getProvision(job.id).log.length).toBeLessThanOrEqual(10);
});

test('startup reconciliation flips a persisted running job to interrupted', () => {
  const saved = [];
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_DHCP),
    load: () => [{ id: 'old', status: 'running', phase: 'create', createdAt: '2026-06-25T00:00:00Z' }],
    save: (jobs) => saved.push(jobs),
  }));
  expect(mgr.getProvision('old').status).toBe('interrupted');
  expect(saved[0][0].status).toBe('interrupted');
});
