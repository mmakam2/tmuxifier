import { test, expect } from 'vitest';
import { createProxmoxInventory, mergeProxmoxStatus } from '../src/server/proxmoxInventory.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const linked = (id, node, vmid, kind = 'lxc') => ({
  id, label: id, host: `192.168.1.${vmid - 100}`,
  proxmox: { hostId: 'H1', node, vmid, kind, endpoint: HOST.endpoint },
});

function setup({ cluster = [], listByNode = {}, boxStore = null, guard } = {}) {
  const calls = { cluster: 0, nodes: [] };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({
      clusterResources: async () => { calls.cluster += 1; return cluster; },
      listGuests: async (kind, node) => { calls.nodes.push(`${kind}:${node}`); return (listByNode[node] || []).filter((g) => (g.type || 'lxc') === kind); },
    }),
    boxStore,
    now: () => 1000,
    freshnessMs: 60_000,
    log: () => {},
  });
  if (guard) inventory.setActiveJobGuard(guard);
  return { inventory, calls };
}

test('refreshLinked makes one cluster call per host and maps vmids across nodes', async () => {
  const { inventory, calls } = setup({ cluster: [
    { vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev-01' },
    { vmid: 132, node: 'pve', type: 'lxc', status: 'stopped', name: 'dev-02' },
    { vmid: 140, node: 'pve2', type: 'lxc', status: 'running', name: 'db-01' },
  ] });
  const records = await inventory.refreshLinked([
    linked('b1', 'pve', 131), linked('b2', 'pve', 132), linked('b3', 'pve2', 140),
  ]);
  expect(calls.cluster).toBe(1); // one call for the whole host, regardless of node spread
  expect(records.map((r) => [r.boxId, r.state, r.node])).toEqual([
    ['b1', 'running', 'pve'], ['b2', 'stopped', 'pve'], ['b3', 'running', 'pve2'],
  ]);
});

test('a migrated container stays healthy, reports its new node, and the link auto-follows', async () => {
  const writes = [];
  const boxStore = {
    setProxmoxLink: async (id, link) => writes.push([id, link]),
    getBox: async () => linked('b1', 'pve-n02', 165), // CAS re-check: fresh link still matches the observed one
  };
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore,
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve-n02', 165)]);
  expect(record.state).toBe('running');
  expect(record.node).toBe('pve-n03');
  expect(writes).toEqual([['b1', { hostId: 'H1', node: 'pve-n03', vmid: 165, kind: 'lxc', endpoint: HOST.endpoint }]]);
});

test('the drift write is skipped while a lifecycle job is active on the box', async () => {
  const writes = [];
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]) },
    guard: (boxId) => boxId === 'b1',
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve-n02', 165)]);
  expect(record.node).toBe('pve-n03'); // display still follows
  expect(writes).toEqual([]);            // store write deferred to a later poll
});

test('a failing drift write is best-effort: logged, record still healthy', async () => {
  const logged = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, node: 'pve-n03', type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: {
      setProxmoxLink: async () => { throw new Error('disk full'); },
      getBox: async () => linked('b1', 'pve-n02', 165), // CAS re-check passes so the write is attempted (and fails)
    },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve-n02', 165)]);
  expect(record.state).toBe('running');
  expect(logged.some((line) => line.includes('disk full'))).toBe(true);
});

test('a malformed node (empty string) from cluster resources is ignored: no write, stored node kept, logged', async () => {
  const writes = [];
  const logged = [];
  const box = linked('b1', 'pve-n02', 165);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, node: '', type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]), getBox: async () => box },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.state).toBe('running');
  expect(record.node).toBe('pve-n02'); // stored node kept, not the malformed value
  expect(writes).toEqual([]);
  expect(logged.some((line) => line.includes('malformed'))).toBe(true);
});

test('a missing node field from cluster resources is ignored the same way', async () => {
  const writes = [];
  const logged = [];
  const box = linked('b1', 'pve-n02', 165);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]), getBox: async () => box },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.node).toBe('pve-n02');
  expect(writes).toEqual([]);
  expect(logged.some((line) => line.includes('malformed'))).toBe(true);
});

test('the drift write is skipped if the link was cleared mid-poll (stale-link re-check)', async () => {
  const writes = [];
  const box = linked('b1', 'pve-n02', 165);
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: {
      setProxmoxLink: async (id, link) => writes.push([id, link]),
      getBox: async () => ({ ...box, proxmox: null }), // user cleared the link between snapshot and write
    },
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.node).toBe('pve-n03'); // display still follows the live cluster value
  expect(writes).toEqual([]);
});

test('the drift write proceeds when the fresh link still matches the observed one (control)', async () => {
  const writes = [];
  const box = linked('b1', 'pve-n02', 165);
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: {
      setProxmoxLink: async (id, link) => writes.push([id, link]),
      getBox: async () => linked('b1', 'pve-n02', 165), // different object, same field values
    },
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.node).toBe('pve-n03');
  expect(writes).toEqual([['b1', { hostId: 'H1', node: 'pve-n03', vmid: 165, kind: 'lxc', endpoint: HOST.endpoint }]]);
});

test('missing means the vmid is absent from the whole cluster', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 999, node: 'pve2', type: 'lxc', status: 'running', name: 'someone-else' }, // different vmid entirely
  ] });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record.state).toBe('missing');
  expect(record.node).toBe('pve'); // stored node kept for display when missing
});

// A same-vmid entry of the OTHER type used to be filtered out entirely (the old
// lxc-only query never saw it), so this vmid read as plain 'missing'. Now that
// both guest types are discovered, that same entry is visible and reported as
// 'mismatch' instead — see the dedicated mismatch tests below for the full
// assertion set (error text, no drift-follow write, etc).
test('a same-vmid entry of the other type is no longer silently invisible — it reports mismatch, not missing', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve2', type: 'qemu', status: 'running', name: 'a-vm' }, // same vmid, wrong type
  ] });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record.state).toBe('mismatch');
  // Unlike the drift-follow STORE WRITE (suppressed on mismatch), the DISPLAYED
  // node reports what the cluster actually shows for this vmid, same as kind.
  expect(record.node).toBe('pve2');
});

test('one host failing leaves another host healthy (per-host isolation)', async () => {
  const HOSTS = { H1: HOST, H2: { ...HOST, id: 'H2', name: 'lab2' } };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => HOSTS[id] },
    makeClient: (host) => ({ clusterResources: async () => {
      if (host.id === 'H2') throw new Error('PVE down');
      return [{ vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev' }];
    } }),
    now: () => 1000, log: () => {},
  });
  const b2 = { ...linked('b2', 'pve', 140), proxmox: { hostId: 'H2', node: 'pve', vmid: 140, endpoint: 'x:8006' } };
  const records = await inventory.refreshLinked([linked('b1', 'pve', 131), b2]);
  const byId = Object.fromEntries(records.map((r) => [r.boxId, r]));
  expect(byId.b1.state).toBe('running');
  expect(byId.b2.state).toBe('unknown');
  expect(byId.b2.error).toBe('PVE down');
});

test('overlapping refreshes coalesce', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => { calls += 1; await gate; return [{ vmid: 131, node: 'pve', type: 'lxc', status: 'running' }]; } }),
  });
  const first = inventory.refreshLinked([box]);
  const second = inventory.refreshLinked([box]);
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});

test('legacy duplicate links retain box-specific records while sharing one host request', async () => {
  const { inventory, calls } = setup({ cluster: [{ vmid: 131, node: 'pve', type: 'lxc', name: 'dev-01', status: 'running' }] });
  const boxes = [linked('b1', 'pve', 131), linked('b2', 'pve', 131)];
  const records = await inventory.refreshLinked(boxes);
  expect(records.map((record) => record.boxId)).toEqual(['b1', 'b2']);
  expect(inventory.stateFor(boxes[0]).boxId).toBe('b1');
  expect(inventory.stateFor(boxes[1]).boxId).toBe('b2');
  expect(calls.cluster).toBe(1);
});

test('stateFor expires cached display authority', async () => {
  let at = 1000;
  const box = linked('b1', 'pve', 131);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 131, node: 'pve', type: 'lxc', status: 'stopped' }] }),
    now: () => at,
    freshnessMs: 100,
  });
  await inventory.refreshBox(box);
  expect(inventory.stateFor(box).state).toBe('stopped');
  at = 1101;
  expect(inventory.stateFor(box)).toBeUndefined();
});

test('listNodeGuests annotates existing links', async () => {
  const { inventory } = setup({ listByNode: { pve: [{ vmid: 131, name: 'dev-01', status: 'running' }, { vmid: 132, name: 'free', status: 'stopped' }] } });
  expect(await inventory.listNodeGuests('H1', 'pve', [linked('b1', 'pve', 131)])).toEqual([
    { hostId: 'H1', node: 'pve', kind: 'lxc', vmid: 131, name: 'dev-01', state: 'running', template: false, linkedBoxId: 'b1' },
    { hostId: 'H1', node: 'pve', kind: 'lxc', vmid: 132, name: 'free', state: 'stopped', template: false, linkedBoxId: null },
  ]);
});

test('a throwing getHost yields unknown for that host only', async () => {
  const b1 = linked('b1', 'pve', 131);
  const b2 = { id: 'b2', label: 'b2', host: '192.168.1.40', proxmox: { hostId: 'H2', node: 'pve', vmid: 140 } };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => { if (id === 'H2') throw new Error('seal open failed'); return HOST; } },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 131, node: 'pve', type: 'lxc', name: 'dev-01', status: 'running' }] }),
    now: () => 1000,
  });
  const records = await inventory.refreshLinked([b1, b2]);
  const byId = new Map(records.map((record) => [record.boxId, record]));
  expect(records).toHaveLength(2);
  expect(byId.get('b1')).toMatchObject({ state: 'running', containerName: 'dev-01', error: null });
  expect(byId.get('b2')).toMatchObject({
    state: 'unknown', hostId: 'H2', node: 'pve', vmid: 140,
    containerName: null, hostName: null, error: 'seal open failed',
  });
});

test('mergeProxmoxStatus adds state without hiding reachable missing links', () => {
  const boxes = [linked('b1', 'pve', 131), linked('b2', 'pve', 132)];
  const merged = mergeProxmoxStatus(
    { b1: { reachable: false, error: 'timeout' }, b2: { reachable: true, tmux: true } },
    boxes,
    [
      { boxId: 'b1', state: 'stopped', node: 'pve', vmid: 131 },
      { boxId: 'b2', state: 'missing', node: 'pve', vmid: 132 },
    ],
  );
  expect(merged.b1).toMatchObject({ reachable: false, proxmoxState: 'stopped', proxmoxVmid: 131 });
  expect(merged.b2).toMatchObject({ reachable: true, proxmoxState: 'missing' });
});

// --- relink-by-endpoint heal: a removed-then-re-added host gets a new id; the
// sweep re-homes orphaned links whose stamped endpoint matches exactly one host.
const READDED = { id: 'H9', name: 'lab-readded', endpoint: HOST.endpoint, tokenSecret: 'sek' };
function healSetup({ hosts = [READDED], cluster = [{ vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev-01' }], boxStore, guard } = {}) {
  const writes = [];
  const logged = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      getHost: async (id) => hosts.find((h) => h.id === id), // the old H1 profile is gone
      listHosts: async () => hosts,
    },
    makeClient: () => ({ clusterResources: async () => cluster }),
    boxStore: boxStore === null ? null : { getBox: async () => null, setProxmoxLink: async (id, link) => writes.push([id, link]), ...boxStore },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  if (guard) inventory.setActiveJobGuard(guard);
  return { inventory, writes, logged };
}

test('an orphaned link re-homes to the unique host with the same endpoint (netboxIpId preserved)', async () => {
  const box = linked('b1', 'pve', 131);
  box.proxmox.netboxIpId = 99;
  const { inventory, writes, logged } = healSetup({ boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([['b1', { hostId: 'H9', node: 'pve', vmid: 131, kind: 'lxc', endpoint: HOST.endpoint, netboxIpId: 99 }]]);
  expect(record).toMatchObject({ state: 'running', hostId: 'H9', hostName: 'lab-readded', containerName: 'dev-01', error: null });
  expect(logged.some((line) => line.includes('re-homed'))).toBe(true);
});

test('an ambiguous endpoint (two matching hosts) never guesses', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({ hosts: [READDED, { ...READDED, id: 'H8', name: 'twin' }], boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ state: 'unknown', hostId: 'H1', error: 'host profile missing' });
});

test('the heal requires the vmid to exist on the candidate cluster', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({ cluster: [], boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('the heal is skipped while a lifecycle job is active on the box', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({ boxStore: { getBox: async () => box }, guard: (boxId) => boxId === 'b1' });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('the heal is skipped if the user re-linked the box mid-poll (CAS re-check)', async () => {
  const box = linked('b1', 'pve', 131);
  const { inventory, writes } = healSetup({
    boxStore: { getBox: async () => ({ ...box, proxmox: { ...box.proxmox, hostId: 'H7' } }) },
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('a link without a stamped endpoint stays orphaned', async () => {
  const box = linked('b1', 'pve', 131);
  delete box.proxmox.endpoint;
  const { inventory, writes } = healSetup({ boxStore: { getBox: async () => box } });
  const [record] = await inventory.refreshLinked([box]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ error: 'host profile missing' });
});

test('without a boxStore the orphan is only reported, never healed', async () => {
  const { inventory } = healSetup({ boxStore: null });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record).toMatchObject({ state: 'unknown', error: 'host profile missing' });
});

test('the drift write preserves netboxIpId on the link', async () => {
  const writes = [];
  const box = linked('b1', 'pve-n02', 165);
  box.proxmox.netboxIpId = 99;
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { getBox: async () => box, setProxmoxLink: async (id, link) => writes.push([id, link]) },
  });
  await inventory.refreshLinked([box]);
  expect(writes[0][1].netboxIpId).toBe(99);
});

test('listClusterNodes maps per-node health, skipping malformed names', async () => {
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      listHosts: async () => [{ id: 'H1' }],
      getHost: async (id) => (id === 'H1' ? HOST : undefined),
    },
    makeClient: () => ({
      clusterNodes: async () => [
        { type: 'node', node: 'pve1', status: 'online', cpu: 0.123, maxcpu: 8, mem: 4000, maxmem: 8000, disk: 30, maxdisk: 100, uptime: 3600 },
        { type: 'node', node: 'pve2', status: 'offline' },
        { type: 'node', node: 'bad node', status: 'online' }, // malformed — skipped
      ],
    }),
    now: () => 1000,
    log: () => {},
  });
  const nodes = await inventory.listClusterNodes();
  expect(nodes).toEqual([
    { hostId: 'H1', hostName: 'lab', node: 'pve1', status: 'online', cpuPct: 12, memPct: 50, diskPct: 30, uptimeSec: 3600, error: null },
    { hostId: 'H1', hostName: 'lab', node: 'pve2', status: 'offline', cpuPct: null, memPct: null, diskPct: null, uptimeSec: null, error: null },
  ]);
});

test('listClusterNodes degrades a failing host to one error record and dedupes same-endpoint profiles', async () => {
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      listHosts: async () => [{ id: 'H1' }, { id: 'H2' }, { id: 'H3' }],
      getHost: async (id) => (
        id === 'H1' ? HOST
        : id === 'H2' ? { ...HOST, id: 'H2', name: 'lab-copy' } // same endpoint — same cluster, skipped
        : { id: 'H3', name: 'lab2', endpoint: 'pve2.example.com:8006', tokenSecret: 'sek' }),
    },
    makeClient: (host) => ({
      clusterNodes: async () => {
        if (host.id === 'H3') throw new Error('connect ECONNREFUSED');
        return [{ type: 'node', node: 'pve1', status: 'online' }];
      },
    }),
    now: () => 1000,
    log: () => {},
  });
  const nodes = await inventory.listClusterNodes();
  expect(nodes).toEqual([
    { hostId: 'H1', hostName: 'lab', node: 'pve1', status: 'online', cpuPct: null, memPct: null, diskPct: null, uptimeSec: null, error: null },
    { hostId: 'H3', hostName: 'lab2', node: null, status: 'error', cpuPct: null, memPct: null, diskPct: null, uptimeSec: null, error: 'connect ECONNREFUSED' },
  ]);
});

test('a linked VM is discovered from the same cluster payload containers come from', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'ct-01' },
    { vmid: 200, node: 'pve', type: 'qemu', status: 'running', name: 'vm-01' },
  ] });
  const records = await inventory.refreshLinked([linked('b1', 'pve', 131), linked('b2', 'pve', 200, 'qemu')]);
  expect(records.map((r) => [r.boxId, r.kind, r.state])).toEqual([
    ['b1', 'lxc', 'running'], ['b2', 'qemu', 'running'],
  ]);
});

test('a vmid whose type disagrees with the link reports mismatch and never writes the link', async () => {
  const writes = [];
  const { inventory } = setup({
    // vmid 165 was destroyed as a container and recreated as a VM on another node.
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'qemu', status: 'running', name: 'someone-elses-vm' }],
    boxStore: {
      setProxmoxLink: async (id, link) => writes.push([id, link]),
      getBox: async () => linked('b1', 'pve-n02', 165),
    },
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve-n02', 165, 'lxc')]);
  expect(record.state).toBe('mismatch');
  expect(record.kind).toBe('qemu');           // report what is actually there
  expect(record.error).toMatch(/165/);
  expect(record.error).toMatch(/re-link/);
  // Load-bearing: a mismatched vmid may not be our guest at all, so the node
  // drift-follow must not write anything back for it.
  expect(writes).toEqual([]);
});

test('re-homing an orphaned link requires the vmid to still be the same kind', async () => {
  const writes = [];
  const hosts = [{ id: 'H2', name: 'lab-readded', endpoint: HOST.endpoint }];
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      listHosts: async () => hosts,
      getHost: async (id) => id === 'H2' ? { ...hosts[0], tokenSecret: 'sek' } : undefined,
    },
    makeClient: () => ({
      clusterResources: async () => [{ vmid: 165, node: 'pve', type: 'qemu', status: 'running', name: 'vm' }],
    }),
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]), getBox: async (id) => box },
    now: () => 1000, log: () => {},
  });
  // The link points at the old host id H1 and says lxc; the re-added profile H2
  // has the right endpoint, but vmid 165 is now a VM.
  const box = { id: 'b1', label: 'b1', host: '192.168.1.65', proxmox: { hostId: 'H1', node: 'pve', vmid: 165, kind: 'lxc', endpoint: HOST.endpoint } };
  const [record] = await inventory.refreshLinked([box]);
  expect(record.error).toBe('host profile missing');
  expect(writes).toEqual([]);
});

test('listNodeGuests merges both kinds, tags each, and sorts by vmid', async () => {
  const { inventory, calls } = setup({ listByNode: { pve: [
    { vmid: 300, type: 'qemu', status: 'running', name: 'vm-hi' },
    { vmid: 131, type: 'lxc', status: 'stopped', name: 'ct-lo' },
    { vmid: 200, type: 'qemu', status: 'stopped', name: 'vm-mid' },
  ] } });
  const rows = await inventory.listNodeGuests('H1', 'pve', [linked('b1', 'pve', 131)]);
  expect(rows.map((r) => [r.vmid, r.kind])).toEqual([[131, 'lxc'], [200, 'qemu'], [300, 'qemu']]);
  expect(rows[0].linkedBoxId).toBe('b1');
  expect(rows[1].linkedBoxId).toBeNull();
  expect(calls.nodes.sort()).toEqual(['lxc:pve', 'qemu:pve']);
});

test('mergeProxmoxStatus carries the guest kind into the status snapshot', () => {
  const boxes = [linked('b1', 'pve', 200, 'qemu')];
  const records = [{ boxId: 'b1', state: 'running', node: 'pve', vmid: 200, kind: 'qemu' }];
  const merged = mergeProxmoxStatus({ b1: { reachable: true } }, boxes, records);
  expect(merged.b1).toMatchObject({ reachable: true, proxmoxState: 'running', proxmoxKind: 'qemu', proxmoxVmid: 200 });
});

// The client-side template guard (the picker, the Guests tab) is not
// sufficient on its own — a second UI surface (paneLifecycle.ts) needs the
// same flag to refuse a lifecycle action, so it must survive the status
// snapshot too, not just the inventory record.
test('mergeProxmoxStatus carries the template flag into the status snapshot', () => {
  const boxes = [linked('b1', 'pve', 300, 'qemu')];
  const records = [{ boxId: 'b1', state: 'stopped', node: 'pve', vmid: 300, kind: 'qemu', template: true }];
  const merged = mergeProxmoxStatus({ b1: { reachable: true } }, boxes, records);
  expect(merged.b1).toMatchObject({ reachable: true, proxmoxState: 'stopped', proxmoxTemplate: true });
});

// F1: a qemu template must never look like an ordinary stopped VM in the
// picker — PVE marks it template: 1 on both the qemu and lxc index rows.
test('listNodeGuests carries the template flag, defaulting false when PVE omits it', async () => {
  const { inventory } = setup({ listByNode: { pve: [
    { vmid: 300, type: 'qemu', status: 'stopped', name: 'vm-template', template: 1 },
    { vmid: 131, type: 'lxc', status: 'stopped', name: 'ct-plain' },
  ] } });
  const rows = await inventory.listNodeGuests('H1', 'pve', []);
  expect(rows.map((r) => [r.vmid, r.template])).toEqual([[131, false], [300, true]]);
});

// A linked guest that was later converted to a template must stay
// recognisable as one, not just render as an ordinary stopped/running guest.
test('a linked guest carries the template flag from the cluster payload', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve', type: 'qemu', status: 'stopped', name: 'was-a-vm', template: 1 },
  ] });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131, 'qemu')]);
  expect(record.template).toBe(true);
});

test('an ordinary linked guest defaults template to false', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve', type: 'lxc', status: 'running', name: 'dev-01' },
  ] });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record.template).toBe(false);
});

// ── Cross-cluster follow (spec 2026-10-05) ─────────────────────────────────
// Two clusters, per-host fake clients, and a box store whose writes land back
// in `boxes`, so CAS re-reads see what a real store would.
const HOSTS = {
  H1: { id: 'H1', name: 'cluster-a', endpoint: 'pve-a.example.com:8006', tokenSecret: 's1' },
  H2: { id: 'H2', name: 'cluster-b', endpoint: 'pve-b.example.com:8006', tokenSecret: 's2' },
};
const FP = { name: 'web01', mac: 'BC:24:11:AA:BB:CC' };
const lxcNet0 = (mac) => `name=eth0,bridge=vmbr0,hwaddr=${mac},ip=dhcp`;
const linkedTo = (id, hostId, node, vmid, extra = {}) => ({
  id, label: id, host: '192.168.1.50',
  proxmox: { hostId, node, vmid, kind: 'lxc', endpoint: HOSTS[hostId].endpoint, ...extra },
});

function clusters({ boxes, resources = {}, configs = {}, hosts = HOSTS, guard, failResources = [], failLink = null }) {
  const calls = { resources: [], config: [] };
  const writes = [];
  const logs = [];
  const store = {
    getBox: async (id) => boxes.find((b) => b.id === id),
    listBoxes: async () => boxes,
    setProxmoxLink: async (id, link) => {
      if (failLink) throw new Error(failLink);
      writes.push([id, link]);
      const i = boxes.findIndex((b) => b.id === id);
      boxes[i] = { ...boxes[i], proxmox: link };
      return boxes[i];
    },
  };
  const inventory = createProxmoxInventory({
    proxmoxStore: {
      getHost: async (id) => hosts[id],
      listHosts: async () => Object.values(hosts).map(({ tokenSecret, ...rest }) => rest),
    },
    makeClient: (host) => ({
      clusterResources: async () => {
        calls.resources.push(host.id);
        if (failResources.includes(host.id)) throw new Error('connect ETIMEDOUT');
        return resources[host.id] || [];
      },
      guestConfig: async (kind, node, vmid) => {
        calls.config.push(`${host.id}:${kind}:${node}:${vmid}`);
        const entry = configs[`${host.id}:${vmid}`];
        const cfg = typeof entry === 'function' ? entry() : entry;
        if (cfg instanceof Error) throw cfg;
        if (!cfg) throw new Error('500 no such guest');
        return cfg;
      },
    }),
    boxStore: store,
    now: () => 1000,
    log: (line) => logs.push(line),
  });
  if (guard) inventory.setActiveJobGuard(guard);
  return { inventory, writes, calls, logs };
}

test('backfill stamps the fingerprint from the guest config on the first poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0('bc:24:11:aa:bb:cc') } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.map(([id, link]) => [id, link.fp])).toEqual([['b1', FP]]);
  expect(boxes[0].proxmox).toEqual({ hostId: 'H1', node: 'a1n', vmid: 120, kind: 'lxc', endpoint: HOSTS.H1.endpoint, fp: FP });
});

test('a stopped guest is stamped too; a missing or mismatched one is not', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120),
    linkedTo('b2', 'H1', 'a1n', 121), // the cluster reports 121 as a VM: mismatch
    linkedTo('b3', 'H1', 'a1n', 122), // absent: missing
  ];
  const net = { net0: lxcNet0(FP.mac) };
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [
      { vmid: 120, node: 'a1n', type: 'lxc', status: 'stopped', name: 'web01' },
      { vmid: 121, node: 'a1n', type: 'qemu', status: 'running', name: 'vm01' },
    ] },
    configs: { 'H1:120': net, 'H1:121': net, 'H1:122': net },
  });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual(['H1:lxc:a1n:120']);
  expect(writes.map(([id]) => id)).toEqual(['b1']);
});

test('a complete fingerprint is never re-read', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0(FP.mac) } },
  });
  await inventory.refreshLinked([...boxes]);
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(writes).toEqual([]);
});

test('a rename refreshes fp.name from the resource list without reading config', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01-new' }] },
  });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(writes.map(([, link]) => link.fp)).toEqual([{ name: 'web01-new', mac: FP.mac }]);
});

test('a failed config read stamps nothing and is retried on the next poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const configs = { 'H1:120': new Error('500 timeout') };
  const { inventory, writes, calls } = clusters({
    boxes, configs,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
  configs['H1:120'] = { net0: lxcNet0(FP.mac) };
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toHaveLength(2);
  expect(writes.map(([, link]) => link.fp)).toEqual([FP]);
});

test('a guest with no usable net0 or name is read once, not every poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120), linkedTo('b2', 'H1', 'a1n', 121)];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [
      { vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' },
      { vmid: 121, node: 'a1n', type: 'lxc', status: 'running', name: 'bad name' },
    ] },
    configs: { 'H1:120': { hostname: 'web01' }, 'H1:121': { net0: lxcNet0(FP.mac) } },
  });
  await inventory.refreshLinked([...boxes]);
  await inventory.refreshLinked([...boxes]);
  expect(calls.config.sort()).toEqual(['H1:lxc:a1n:120', 'H1:lxc:a1n:121']);
  expect(writes).toEqual([]);
});

test('stamping is skipped while a lifecycle job is active on the box', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes, calls } = clusters({
    boxes, guard: () => true,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0(FP.mac) } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(writes).toEqual([]);
});

test('stamping is skipped if the box was re-linked while the config was being read (CAS)', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': () => { boxes[0] = linkedTo('b1', 'H1', 'a1n', 125); return { net0: lxcNet0(FP.mac) }; } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('refreshBox with follow:false never stamps', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [{ vmid: 120, node: 'a1n', type: 'lxc', status: 'running', name: 'web01' }] },
    configs: { 'H1:120': { net0: lxcNet0(FP.mac) } },
  });
  const record = await inventory.refreshBox(boxes[0], { follow: false });
  expect(record.state).toBe('running');
  expect(calls.config).toEqual([]);
  expect(writes).toEqual([]);
});

const movedGuest = (vmid, extra = {}) => ({ vmid, node: 'b1n', type: 'lxc', status: 'running', name: 'web01', ...extra });
const NET = { net0: lxcNet0(FP.mac) };

test('a missing guest found once on another cluster re-homes the link, keeping kind, fp and netboxIpId', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP, netboxIpId: 7 })];
  const { inventory, writes, logs } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  const [record] = await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([['b1', {
    hostId: 'H2', node: 'b1n', vmid: 305, kind: 'lxc', endpoint: HOSTS.H2.endpoint, fp: FP, netboxIpId: 7,
  }]]);
  expect(record).toMatchObject({ boxId: 'b1', hostId: 'H2', hostName: 'cluster-b', node: 'b1n', vmid: 305, state: 'running', error: null });
  expect(logs.some((line) => line.includes('guest moved'))).toBe(true);
});

test('a guest restored under a new vmid on its own cluster follows too', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, resources: { H1: [movedGuest(121, { node: 'a2n' })], H2: [] }, configs: { 'H1:121': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.map(([, link]) => [link.hostId, link.node, link.vmid])).toEqual([['H1', 'a2n', 121]]);
});

test.each([
  ['no match anywhere', [], {}],
  ['two matches', [movedGuest(305), movedGuest(306)], { 'H2:305': NET, 'H2:306': NET }],
  ['a locked candidate', [movedGuest(305, { lock: 'migrate' })], { 'H2:305': NET }],
  ['a template candidate', [movedGuest(305, { template: 1 })], { 'H2:305': NET }],
  ['a kind mismatch', [movedGuest(305, { type: 'qemu' })], { 'H2:305': { net0: `virtio=${FP.mac},bridge=vmbr0` } }],
  ['a name mismatch', [movedGuest(305, { name: 'web02' })], { 'H2:305': NET }],
  ['a MAC mismatch', [movedGuest(305)], { 'H2:305': { net0: lxcNet0('BC:24:11:00:00:99') } }],
  ['a malformed node', [movedGuest(305, { node: 'bad node' })], { 'H2:305': NET }],
  ['an out-of-range vmid', [movedGuest(42)], { 'H2:42': NET }],
  ['a candidate whose config read fails', [movedGuest(305)], { 'H2:305': new Error('500') }],
  ['a locked same-name guest beside one clean match', [movedGuest(305), movedGuest(306, { lock: 'migrate' })], { 'H2:305': NET, 'H2:306': NET }],
])('no follow on %s: nothing written, record stays missing', async (_label, h2, configs) => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: h2 }, configs });
  const [record] = await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
  expect(record).toMatchObject({ hostId: 'H1', vmid: 120, state: 'missing' });
});

test('a link without a complete fingerprint is never followed and searches nothing', async () => {
  for (const extra of [{}, { fp: { name: 'web01' } }]) {
    const boxes = [linkedTo('b1', 'H1', 'a1n', 120, extra)];
    const { inventory, writes, calls } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
    await inventory.refreshLinked([...boxes]);
    expect(writes).toEqual([]);
    expect(calls.resources).toEqual(['H1']); // H2 was never asked
  }
});

test('a candidate already linked to another box is not a match', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }), linkedTo('b2', 'H2', 'b1n', 305, { fp: { name: 'web01', mac: 'BC:24:11:00:00:02' } })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
  await inventory.refreshLinked([...boxes]);
  expect(writes.filter(([id]) => id === 'b1')).toEqual([]);
});

test('an unreadable host profile makes the search incomplete: no follow even with one match elsewhere', async () => {
  const hosts = { ...HOSTS, H3: { id: 'H3', name: 'cluster-c', endpoint: 'pve-c.example.com:8006', tokenSecret: 's3' } };
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, hosts, failResources: ['H3'], resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('two profiles with the same endpoint are searched once, so one guest is one match', async () => {
  const hosts = { ...HOSTS, H2b: { id: 'H2b', name: 'cluster-b-alias', endpoint: HOSTS.H2.endpoint, tokenSecret: 's4' } };
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, hosts, resources: { H1: [], H2: [movedGuest(305)], H2b: [movedGuest(305)] },
    configs: { 'H2:305': NET, 'H2b:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.map(([, link]) => link.hostId)).toEqual(['H2']);
});

test('two missing boxes resolving to the same guest both stay put', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }), linkedTo('b2', 'H1', 'a1n', 121, { fp: FP })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('the follow is skipped while a lifecycle job is active on the box', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, guard: () => true, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('the follow is skipped if the box was re-linked mid-poll (CAS)', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305)] },
    configs: { 'H2:305': () => { boxes[0] = linkedTo('b1', 'H1', 'a1n', 130); return NET; } },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
});

test('a store refusal (already linked) is logged, never thrown, and the record stays missing', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, logs } = clusters({
    boxes, failLink: 'proxmox guest is already linked',
    resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  const [record] = await inventory.refreshLinked([...boxes]);
  expect(record.state).toBe('missing');
  expect(logs.some((line) => line.includes('could not follow'))).toBe(true);
});

test('a missing guest with no same-name candidate costs no config read and no repeat cluster call', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, calls } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305, { name: 'other' })] } });
  await inventory.refreshLinked([...boxes]);
  expect(calls.config).toEqual([]);
  expect(calls.resources).toEqual(['H1', 'H2']);
});

test('an ambiguous search is logged once, not on every poll', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, logs } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305), movedGuest(306)] }, configs: { 'H2:305': NET, 'H2:306': NET },
  });
  await inventory.refreshLinked([...boxes]);
  await inventory.refreshLinked([...boxes]);
  expect(logs.filter((line) => line.includes('not following'))).toHaveLength(1);
});

test('refreshBox with follow:false never re-homes', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET } });
  const record = await inventory.refreshBox(boxes[0], { follow: false });
  expect(record.state).toBe('missing');
  expect(writes).toEqual([]);
});

test('findFollowCandidates reports matches and unreadable profiles without writing', async () => {
  const hosts = { ...HOSTS, H3: { id: 'H3', name: 'cluster-c', endpoint: 'pve-c.example.com:8006', tokenSecret: 's3' } };
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes } = clusters({
    boxes, hosts, failResources: ['H3'], resources: { H1: [], H2: [movedGuest(305)] }, configs: { 'H2:305': NET },
  });
  await expect(inventory.findFollowCandidates(boxes[0])).resolves.toEqual({
    found: [{ hostId: 'H2', hostName: 'cluster-b', vmid: 305, node: 'b1n' }],
    unreachable: ['cluster-c'], locked: [], twins: [],
  });
  expect(writes).toEqual([]);
});

test('findFollowCandidates is empty for a link without a fingerprint', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120)];
  const { inventory, calls } = clusters({ boxes, resources: { H1: [], H2: [movedGuest(305)] } });
  await expect(inventory.findFollowCandidates(boxes[0])).resolves.toEqual({ found: [], unreachable: [], locked: [], twins: [] });
  expect(calls.resources).toEqual([]);
});

// ── Final-review fixes (2026-10-05): aliases, twins, locked guests, concurrency ──
const ALIAS_SAME = { ...HOSTS, H2b: { id: 'H2b', name: 'cluster-b-alias', endpoint: HOSTS.H2.endpoint, tokenSecret: 's4' } };
const ALIAS_NODE = { ...HOSTS, H2c: { id: 'H2c', name: 'cluster-b-node2', endpoint: 'pve-b2.example.com:8006', tokenSecret: 's5' } };
const linkedVia = (hosts, id, hostId, node, vmid, extra = {}) => ({
  id, label: id, host: '192.168.1.51',
  proxmox: { hostId, node, vmid, kind: 'lxc', endpoint: hosts[hostId].endpoint, ...extra },
});

test.each([
  ['no fingerprint', {}],
  ['a different fingerprint', { fp: { name: 'web01', mac: 'BC:24:11:00:00:02' } }],
])('A(a) a guest linked through a same-endpoint alias profile (b2 with %s) is not a match', async (_label, extra) => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }),
    linkedVia(ALIAS_SAME, 'b2', 'H2b', 'b1n', 305, extra),
  ];
  const { inventory, writes } = clusters({
    boxes, hosts: ALIAS_SAME,
    resources: { H1: [], H2: [movedGuest(305)], H2b: [movedGuest(305)] },
    configs: { 'H2:305': NET, 'H2b:305': NET },
  });
  const records = await inventory.refreshLinked([...boxes]);
  expect(writes.filter(([id]) => id === 'b1')).toEqual([]);
  expect(records.find((r) => r.boxId === 'b1')).toMatchObject({ hostId: 'H1', vmid: 120, state: 'missing' });
});

test('A(b) a guest linked through a different-endpoint alias by a box carrying the same fingerprint is not followed', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }),
    linkedVia(ALIAS_NODE, 'b2', 'H2c', 'b1n', 305, { fp: FP }),
  ];
  const { inventory, writes, logs } = clusters({
    boxes, hosts: ALIAS_NODE,
    resources: { H1: [], H2: [movedGuest(305)], H2c: [movedGuest(305)] },
    configs: { 'H2:305': NET, 'H2c:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.filter(([id]) => id === 'b1')).toEqual([]);
  expect(logs.some((line) => line.includes('box b1') && line.includes('not following') && line.includes('b2'))).toBe(true);
});

test('A(b) another box carrying the same complete fingerprint makes the guest contested: no follow, logged by label', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }),
    linkedTo('b2', 'H2', 'b1n', 400, { fp: FP }),
  ];
  const { inventory, writes, logs } = clusters({
    boxes,
    resources: { H1: [], H2: [movedGuest(305), movedGuest(400)] },
    configs: { 'H2:305': NET, 'H2:400': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.filter(([id]) => id === 'b1')).toEqual([]);
  expect(logs.some((line) => line.includes('box b1') && line.includes('box b2 carries the same fingerprint'))).toBe(true);
});

test('A(c) a box linked this poll is stamped before another box searches, so its twin does not follow', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }),
    linkedVia(ALIAS_NODE, 'b2', 'H2c', 'b1n', 305), // no fp yet: stamped by this same refresh
  ];
  const { inventory, writes } = clusters({
    boxes, hosts: ALIAS_NODE,
    resources: { H1: [], H2: [movedGuest(305)], H2c: [movedGuest(305)] },
    configs: { 'H2:305': NET, 'H2c:305': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes.filter(([id]) => id === 'b1')).toEqual([]);
  expect(writes.filter(([id]) => id === 'b2').map(([, link]) => link.fp)).toEqual([FP]);
});

test('A(b) a single-box refresh still sees a twin elsewhere in the fleet', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }),
    linkedVia(ALIAS_NODE, 'b2', 'H2c', 'b1n', 305, { fp: FP }),
  ];
  const { inventory, writes } = clusters({
    boxes, hosts: ALIAS_NODE,
    resources: { H1: [], H2: [movedGuest(305)], H2c: [movedGuest(305)] },
    configs: { 'H2:305': NET, 'H2c:305': NET },
  });
  const record = await inventory.refreshBox(boxes[0]);
  expect(record).toMatchObject({ hostId: 'H1', vmid: 120, state: 'missing' });
  expect(writes).toEqual([]);
});

test('A(b) findFollowCandidates reports a twin by label', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }),
    linkedTo('b2', 'H2', 'b1n', 400, { fp: FP }),
  ];
  const { inventory, writes } = clusters({
    boxes,
    resources: { H1: [], H2: [movedGuest(305), movedGuest(400)] },
    configs: { 'H2:305': NET, 'H2:400': NET },
  });
  await expect(inventory.findFollowCandidates(boxes[0])).resolves.toEqual({
    found: [{ hostId: 'H2', hostName: 'cluster-b', vmid: 305, node: 'b1n' }],
    unreachable: [], locked: [], twins: ['b2'],
  });
  expect(writes).toEqual([]);
});

test('A(b) a fingerprint of the other kind, or with another MAC, is not a twin', async () => {
  const boxes = [
    linkedTo('b1', 'H1', 'a1n', 120, { fp: FP }),
    linkedTo('b2', 'H2', 'b1n', 400, { fp: FP, kind: 'qemu' }),
    linkedTo('b3', 'H2', 'b1n', 401, { fp: { name: 'web01', mac: 'BC:24:11:00:00:03' } }),
  ];
  const { inventory } = clusters({ boxes, resources: { H1: [], H2: [] } });
  await expect(inventory.findFollowCandidates(boxes[0])).resolves.toMatchObject({ twins: [] });
});

test('B a locked same-name guest blocks the follow and is reported in locked', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, writes, calls } = clusters({
    boxes,
    resources: { H1: [], H2: [movedGuest(305), movedGuest(306, { lock: 'migrate' }), movedGuest(307, { lock: 'backup', name: 'web02' })] },
    configs: { 'H2:305': NET, 'H2:306': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(writes).toEqual([]);
  await expect(inventory.findFollowCandidates(boxes[0])).resolves.toEqual({
    found: [{ hostId: 'H2', hostName: 'cluster-b', vmid: 305, node: 'b1n' }],
    unreachable: [], locked: [{ hostId: 'H2', hostName: 'cluster-b', vmid: 306 }], twins: [],
  });
  expect(calls.config.every((c) => !c.endsWith(':306'))).toBe(true); // a locked guest is never read
});

test('C profiles are read concurrently, so a slow cluster does not serialize the search', async () => {
  const hosts = { ...HOSTS, H3: { id: 'H3', name: 'cluster-c', endpoint: 'pve-c.example.com:8006', tokenSecret: 's3' } };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, calls } = clusters({
    boxes, hosts, resources: { H1: [], H2: gate.then(() => []), H3: gate.then(() => []) },
  });
  const done = inventory.refreshLinked([...boxes]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = [...calls.resources];
  release();
  await done;
  expect(started).toEqual(['H1', 'H2', 'H3']);
});

test('C candidate configs are read concurrently', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, calls, writes } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305), movedGuest(306)] },
    configs: { 'H2:305': () => gate.then(() => NET), 'H2:306': () => gate.then(() => ({ net0: lxcNet0('BC:24:11:00:00:09') })) },
  });
  const done = inventory.refreshLinked([...boxes]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = [...calls.config];
  release();
  await done;
  expect(started).toEqual(['H2:lxc:b1n:305', 'H2:lxc:b1n:306']);
  expect(writes.map(([, link]) => link.vmid)).toEqual([305]); // the match survives concurrency
});

test('D1 an ambiguous search names the matching profiles and vmids', async () => {
  const boxes = [linkedTo('b1', 'H1', 'a1n', 120, { fp: FP })];
  const { inventory, logs } = clusters({
    boxes, resources: { H1: [], H2: [movedGuest(305), movedGuest(306)] }, configs: { 'H2:305': NET, 'H2:306': NET },
  });
  await inventory.refreshLinked([...boxes]);
  expect(logs.some((line) => line.includes('2 fingerprint match(es): cluster-b/305, cluster-b/306'))).toBe(true);
});

test('D2 the node auto-follow writes from the fresh link, keeping a just-stamped fp', async () => {
  const writes = [];
  const snapshot = linked('b1', 'pve-n02', 165);
  const fresh = { ...snapshot, proxmox: { ...snapshot.proxmox, fp: FP } };
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'pve-n03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { getBox: async () => fresh, setProxmoxLink: async (id, link) => writes.push([id, link]) },
  });
  await inventory.refreshBox(snapshot, { follow: false });
  expect(writes).toEqual([['b1', { ...fresh.proxmox, node: 'pve-n03' }]]);
});
