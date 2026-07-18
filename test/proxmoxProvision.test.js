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

// An ip override must never redirect a dhcp container's box link: buildNet0
// ignores overrides for dhcp (net0 stays `ip=dhcp`), so an override address is
// never actually the container's — only the DHCP-leased address is.
test('dhcp + ip override: net0 stays dhcp and the box links from the leased address, not the override', async () => {
  const boxStore = fakeBoxStore();
  let captured;
  const client = { ...okClient(), createLxc: async (_node, params) => { captured = params; return 'UPID:create'; } };
  const mgr = createProvisionManager(base({ proxmoxStore: makeStore(PRESET_DHCP), boxStore, makeClient: () => client }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-10', ip: '192.168.1.99/24' });
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('done');
  expect(captured.net0).toContain('ip=dhcp');
  expect(boxStore.added[0].host).toBe('192.168.1.77');
  expect(boxStore.added[0].host).not.toBe('192.168.1.99');
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

// auto-static: allocate-ip phase reserves a NetBox address before create, and
// rolls the reservation back if the container never materializes.
const PRESET_AUTO = { ...PRESET_DHCP, id: 'p3', net: { bridge: 'vmbr0', ipMode: 'auto-static', cidr: null, gateway: null, vlan: 30 } };

function fakeNetbox({ full = false, failRelease = false } = {}) {
  const calls = [];
  const client = {
    findPrefixByVlan: async (vid) => { calls.push(['find', vid]); return { id: 7, prefix: '192.168.30.0/24' }; },
    allocateIp: async (prefix, fields) => {
      calls.push(['allocate', prefix.id, fields]);
      if (full) throw new Error(`prefix ${prefix.prefix} has no available IPs`);
      return { id: 99, address: '192.168.30.50/24', gateway: '192.168.30.1' };
    },
    releaseIp: async (id) => { calls.push(['release', id]); if (failRelease) throw new Error('netbox down'); },
  };
  return { calls, client };
}
const nbStore = { getSettings: async () => ({ url: 'https://netbox.example.com', tlsMode: 'ca', fingerprint256: null, token: 't' }) };

test('auto-static allocates before create, provisions with the allocated CIDR, and stamps netboxIpId on the link', async () => {
  const { calls, client: netbox } = fakeNetbox();
  const boxStore = fakeBoxStore();
  const createCalls = [];
  const client = { ...okClient(), createLxc: async (node, params) => { createCalls.push(params); return 'UPID:create'; } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore, makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  const done = m.getProvision(j.id);
  expect(done.status).toBe('done');
  expect(done.netboxIpId).toBe(99);
  expect(calls[0]).toEqual(['find', 30]);
  expect(calls[1][2]).toEqual({ status: 'active', description: 'tmuxifier: dev-01' });
  expect(createCalls[0].net0).toContain('ip=192.168.30.50/24');
  expect(createCalls[0].net0).toContain('gw=192.168.30.1'); // inferred, not from the preset
  expect(done.gateway).toBe('192.168.30.1');
  expect(done.log).toContain('gw 192.168.30.1');
  expect(boxStore.added[0].host).toBe('192.168.30.50');
  expect(boxStore.added[0].proxmox.netboxIpId).toBe(99);
  expect(calls.some((c) => c[0] === 'release')).toBe(false);
});

// A NetBox-recycled IP may still carry a stale known_hosts entry from
// whatever previously lived at that address. Forgetting it before linking
// the box means Tmuxifier never falsely flags the fresh container as a
// spoofed host.
test('provision forgets any stale host key for the new IP before linking the box', async () => {
  const { client: netbox } = fakeNetbox();
  const boxStore = fakeBoxStore();
  const events = [];
  const trackedStore = { ...boxStore, addBox: async (b, o) => { events.push(['addBox', b.host]); return boxStore.addBox(b, o); } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: trackedStore, makeClient: () => okClient(),
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    knownHosts: { forget: async (host, port) => { events.push(['forget', host, port]); return []; } },
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
  expect(events).toEqual([['forget', '192.168.30.50', 22], ['addBox', '192.168.30.50']]);
});

test('provision succeeds even when forgetting the host key rejects', async () => {
  const { client: netbox } = fakeNetbox();
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => okClient(),
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    knownHosts: { forget: async () => { throw new Error('boom'); } },
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
});

// The DHCP-leased address comes from the PVE API's lxcInterfaces response,
// which isn't otherwise validated until addBox's assertBoxSafe runs. A
// compromised/misbehaving PVE endpoint must not be able to make Tmuxifier
// remove an attacker-chosen known_hosts entry.
test('dhcp discover: a non-IP inet from the PVE API is never passed to known_hosts forget', async () => {
  const boxStore = fakeBoxStore();
  const events = [];
  const client = okClient({ ifaces: [{ name: 'eth0', inet: 'evil.example.com/24' }] });
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_DHCP), boxStore, makeClient: () => client,
    knownHosts: { forget: async (host, port) => { events.push(['forget', host, port]); return []; } },
  }));
  const job = await mgr.createProvision({ presetId: 'p1', hostname: 'dev-11' });
  await mgr._settled(job.id);
  const done = mgr.getProvision(job.id);
  expect(done.status).toBe('done');
  expect(events).toEqual([]); // never forget based on an unvalidated discovered hostname
  expect(boxStore.added[0].host).toBe('evil.example.com'); // link phase still proceeds unaffected
});

test('a legacy auto-static preset with a stored gateway still uses the inferred one', async () => {
  const { client: netbox } = fakeNetbox();
  const createCalls = [];
  const client = { ...okClient(), createLxc: async (node, params) => { createCalls.push(params); return 'UPID:create'; } };
  const legacy = { ...PRESET_AUTO, net: { ...PRESET_AUTO.net, gateway: '192.168.30.254' } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(legacy), boxStore: fakeBoxStore(), makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
  expect(createCalls[0].net0).toContain('gw=192.168.30.1');       // inferred wins
  expect(createCalls[0].net0).not.toContain('gw=192.168.30.254'); // stored legacy value ignored
});

// Fail fast: an auto-static preset is rejected at createProvision time when
// NetBox is not configured — no job may be created or persisted. The
// allocate-ip phase check stays as a backstop for settings cleared mid-job.
test('auto-static without NetBox settings rejects before a job exists', async () => {
  const saves = [];
  const m = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_AUTO), makeClient: () => okClient(),
    save: (list) => saves.push(list),
  }));
  await expect(m.createProvision({ presetId: 'p3', hostname: 'dev-01' }))
    .rejects.toThrow(/auto-static requires the NetBox integration/);
  expect(m.listProvisions()).toEqual([]);
  expect(saves.flat()).toEqual([]); // nothing persisted either
});

test('a create failure releases the reserved IP and the job errors', async () => {
  const { calls, client: netbox } = fakeNetbox();
  const client = { ...okClient(), createLxc: async () => { throw new Error('storage full'); } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  const done = m.getProvision(j.id);
  expect(done.status).toBe('error');
  expect(calls.at(-1)).toEqual(['release', 99]);
  expect(done.log).toContain('released NetBox ip 99');
});

test('an unusable NetBox address aborts before create and releases the reservation', async () => {
  const calls = [];
  const netbox = {
    findPrefixByVlan: async (vid) => { calls.push(['find', vid]); return { id: 7, prefix: '192.168.30.0/24' }; },
    allocateIp: async (prefix, fields) => { calls.push(['allocate', prefix.id, fields]); return { id: 99, address: 'not-a-cidr' }; },
    releaseIp: async (id) => { calls.push(['release', id]); },
  };
  const createCalls = [];
  const client = { ...okClient(), createLxc: async () => { createCalls.push(1); return 'UPID:create'; } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  const done = m.getProvision(j.id);
  expect(done.status).toBe('error');
  expect(done.error).toMatch(/unusable address/);
  expect(createCalls).toHaveLength(0);
  expect(calls.at(-1)).toEqual(['release', 99]);
});

test('a prefix failure aborts before any container is created', async () => {
  const netbox = { findPrefixByVlan: async () => { throw new Error('no NetBox prefix for VLAN 30'); } };
  const createCalls = [];
  const client = { ...okClient(), createLxc: async () => { createCalls.push(1); return 'UPID:create'; } };
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: () => client,
    netboxStore: nbStore, makeNetboxClient: () => netbox,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('error');
  expect(m.getProvision(j.id).error).toContain('no NetBox prefix');
  expect(createCalls).toHaveLength(0);
});

test('unconfigured NetBox fails fast with the settings-modal message', async () => {
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: okClient,
    netboxStore: { getSettings: async () => null },
    load: () => [], save: () => {},
  });
  await expect(m.createProvision({ presetId: 'p3', hostname: 'dev-01' }))
    .rejects.toThrow(/configure it in Settings/);
  expect(m.listProvisions()).toEqual([]);
});

// The allocate-ip phase re-checks settings as a backstop: clearing NetBox
// between the accepted request and the phase running errors the job.
test('settings cleared after the request still error in the allocate-ip phase', async () => {
  let calls = 0;
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_AUTO), boxStore: fakeBoxStore(), makeClient: okClient,
    netboxStore: { getSettings: async () => (++calls === 1 ? nbStore.getSettings() : null) },
    makeNetboxClient: () => fakeNetbox().client,
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p3', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('error');
  expect(m.getProvision(j.id).error).toContain('configure it in Settings');
});

test('dhcp and static presets never touch the NetBox client', async () => {
  let touched = 0;
  const m = createProvisionManager({
    proxmoxStore: makeStore(PRESET_STATIC), boxStore: fakeBoxStore(), makeClient: okClient,
    netboxStore: nbStore, makeNetboxClient: () => { touched += 1; return {}; },
    load: () => [], save: () => {},
  });
  const j = await m.createProvision({ presetId: 'p2', hostname: 'dev-01' });
  await m._settled(j.id);
  expect(m.getProvision(j.id).status).toBe('done');
  expect(touched).toBe(0);
});

test('startSetup is fired on link with the linked box and stored setupOptions', async () => {
  const started = [];
  const boxStore = fakeBoxStore();
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_STATIC),
    boxStore,
    makeClient: () => okClient(),
    startSetup: (box, options, opts) => started.push({ box, options, opts }),
  }));
  const job = await mgr.createProvision({ presetId: 'p2', hostname: 'dev-01', setupOptions: { ohMyTmux: true, tools: ['git'] } });
  await mgr._settled(job.id);
  expect(started).toHaveLength(1);
  expect(started[0].box).toBe(boxStore.added[0]);         // the just-linked box
  expect(started[0].options).toEqual({ ohMyTmux: true, tools: ['git'] });
  expect(started[0].opts).toEqual({ waitForSsh: true });
});

test('no setupOptions -> startSetup is not called', async () => {
  const started = [];
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_STATIC), boxStore: fakeBoxStore(),
    makeClient: () => okClient(), startSetup: () => started.push(1),
  }));
  await mgr._settled((await mgr.createProvision({ presetId: 'p2', hostname: 'dev-01' })).id);
  expect(started).toHaveLength(0);
});

test('the in-memory job map prunes terminal jobs past maxJobs, like the persisted file', async () => {
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_STATIC), makeClient: () => okClient(), maxJobs: 2,
  }));
  for (const name of ['dev-01', 'dev-02', 'dev-03']) {
    await mgr._settled((await mgr.createProvision({ presetId: 'p2', hostname: name })).id);
  }
  const listed = mgr.listProvisions();
  expect(listed).toHaveLength(2);
  expect(listed.map((j) => j.hostname)).toEqual(['dev-03', 'dev-02']); // newest kept
});

test('a NetBox settings read/decrypt error surfaces as itself, not as "not configured"', async () => {
  const mgr = createProvisionManager(base({
    proxmoxStore: makeStore(PRESET_AUTO), makeClient: () => okClient(),
    netboxStore: { getSettings: async () => { throw new Error('sealed secret decrypt failed'); } },
  }));
  await expect(mgr.createProvision({ presetId: 'p3', hostname: 'dev-01' }))
    .rejects.toThrow(/decrypt failed/);
  await expect(mgr.createProvision({ presetId: 'p3', hostname: 'dev-02' }))
    .rejects.not.toThrow(/configure it in Settings/);
});
