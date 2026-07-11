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
    getRootPassword: async () => null,
  };
}
function fakeBoxStore() {
  const added = [];
  const addOptions = [];
  return {
    added, addOptions,
    addBox: async (spec, options) => {
      const box = { id: `box-${added.length + 1}`, ...spec };
      added.push(box); addOptions.push(options); return box;
    },
  };
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

test('injects the default host key + all stored keys + the root password into createLxc', async () => {
  let captured;
  const client = { ...okClient(), createLxc: async (_node, params) => { captured = params; return 'UPID:create'; } };
  const store = {
    getPreset: async () => PRESET_STATIC,
    getHost: async () => HOST,
    listKeys: async () => [{ id: 'k1', publicKey: 'ssh-ed25519 ADDED you@example.com' }],
    getRootPassword: async () => 'sekret12',
  };
  const mgr = createProvisionManager(base({ proxmoxStore: store, makeClient: () => client, defaultPublicKey: () => 'ssh-ed25519 HOSTKEY tmuxifier@host' }));
  await mgr._settled((await mgr.createProvision({ presetId: 'p2', hostname: 'dev-01' })).id);
  expect(captured['ssh-public-keys']).toBe('ssh-ed25519 HOSTKEY tmuxifier@host\nssh-ed25519 ADDED you@example.com\n');
  expect(captured.password).toBe('sekret12');
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
  expect(boxStore.addOptions[0]).toEqual({ trustedProxmox: true });
  expect(done.boxId).toBe('box-1');
});

test('provision tags are applied to the linked box; absent tags fall back to preset boxDefaults', async () => {
  const tagged = fakeBoxStore();
  const m1 = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), boxStore: tagged, makeClient: () => okClient() }));
  await m1._settled((await m1.createProvision({ presetId: 'p2', hostname: 'dev-01', tags: ['prod'] })).id);
  expect(tagged.added[0].tags).toEqual(['prod']);

  const untagged = fakeBoxStore();
  const m2 = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), boxStore: untagged, makeClient: () => okClient() }));
  await m2._settled((await m2.createProvision({ presetId: 'p2', hostname: 'dev-02' })).id);
  expect(untagged.added[0].tags).toEqual([]); // PRESET_STATIC boxDefaults.tags is []
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

test('task log is capped at maxLogBytes', async () => {
  const client = { ...okClient(), taskLog: async () => [{ n: 1, t: 'x'.repeat(100) }] };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), makeClient: () => client, maxLogBytes: 10 }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-06' });
  await mgr._settled(job.id);
  expect(mgr.getProvision(job.id).log.length).toBeLessThanOrEqual(10);
});

test('a legacy persisted cancelled job stays terminal at reconciliation (cancel API removed)', () => {
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_DHCP),
    load: () => [{ id: 'legacy', status: 'cancelled', phase: 'create', createdAt: '2026-06-25T00:00:00Z' }],
  }));
  expect(mgr.getProvision('legacy').status).toBe('cancelled'); // not flipped to interrupted
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

// One network blip or pveproxy restart during the minutes-long create/start
// poll used to throw straight out of pollTask — the job was marked error while
// the LXC kept creating on PVE (orphaned container, misleading outcome). Only
// N consecutive taskStatus failures count as a real outage.
test('transient taskStatus failures during the poll do not fail the job', async () => {
  let calls = 0;
  const client = {
    ...okClient(),
    taskStatus: async () => {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error('pveproxy restarting');
      return { status: 'stopped', exitstatus: 'OK' };
    },
  };
  const boxStore = fakeBoxStore();
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), boxStore, makeClient: () => client }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-07' });
  await mgr._settled(job.id);
  expect(mgr.getProvision(job.id).status).toBe('done');
  expect(boxStore.added).toHaveLength(1); // the box still got linked
});

test('persistent taskStatus failures fail the job once the tolerance is exhausted', async () => {
  let calls = 0;
  const client = { ...okClient(), taskStatus: async () => { calls += 1; throw new Error('connect ECONNREFUSED'); } };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_STATIC), makeClient: () => client, maxPollFailures: 3 }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-08' });
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('error');
  expect(done.error).toMatch(/ECONNREFUSED/);
  expect(calls).toBe(3); // gave up after exactly the tolerance, not the task timeout
});

test('a success between failures resets the consecutive-failure count', async () => {
  let calls = 0;
  const client = {
    ...okClient(),
    // fail, fail, ok(running), fail, fail, ok(stopped): never 3 consecutive
    taskStatus: async () => {
      calls += 1;
      if ([1, 2, 4, 5].includes(calls)) throw new Error('blip');
      if (calls === 3) return { status: 'running' };
      return { status: 'stopped', exitstatus: 'OK' };
    },
  };
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore({ ...PRESET_STATIC, startAfterCreate: false }),
    makeClient: () => client, maxPollFailures: 3,
  }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-09' });
  await mgr._settled(job.id);
  expect(mgr.getProvision(job.id).status).toBe('done');
});
