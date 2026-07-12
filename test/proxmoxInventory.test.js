import { test, expect } from 'vitest';
import { createProxmoxInventory, mergeProxmoxStatus } from '../src/server/proxmoxInventory.js';

const HOST = { id: 'H1', name: 'lab', endpoint: 'pve.example.com:8006', tokenSecret: 'sek' };
const linked = (id, node, vmid) => ({
  id, label: id, host: `192.168.1.${vmid - 100}`,
  proxmox: { hostId: 'H1', node, vmid, endpoint: HOST.endpoint },
});

function setup({ cluster = [], listByNode = {}, boxStore = null, guard } = {}) {
  const calls = { cluster: 0, nodes: [] };
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async (id) => id === 'H1' ? HOST : undefined },
    makeClient: () => ({
      clusterResources: async () => { calls.cluster += 1; return cluster; },
      listLxc: async (node) => { calls.nodes.push(node); return listByNode[node] || []; },
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
    getBox: async () => linked('b1', 'proxmox02', 165), // CAS re-check: fresh link still matches the observed one
  };
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore,
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.state).toBe('running');
  expect(record.node).toBe('proxmox03');
  expect(writes).toEqual([['b1', { hostId: 'H1', node: 'proxmox03', vmid: 165, endpoint: HOST.endpoint }]]);
});

test('the drift write is skipped while a lifecycle job is active on the box', async () => {
  const writes = [];
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]) },
    guard: (boxId) => boxId === 'b1',
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.node).toBe('proxmox03'); // display still follows
  expect(writes).toEqual([]);            // store write deferred to a later poll
});

test('a failing drift write is best-effort: logged, record still healthy', async () => {
  const logged = [];
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: {
      setProxmoxLink: async () => { throw new Error('disk full'); },
      getBox: async () => linked('b1', 'proxmox02', 165), // CAS re-check passes so the write is attempted (and fails)
    },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([linked('b1', 'proxmox02', 165)]);
  expect(record.state).toBe('running');
  expect(logged.some((line) => line.includes('disk full'))).toBe(true);
});

test('a malformed node (empty string) from cluster resources is ignored: no write, stored node kept, logged', async () => {
  const writes = [];
  const logged = [];
  const box = linked('b1', 'proxmox02', 165);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, node: '', type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]), getBox: async () => box },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.state).toBe('running');
  expect(record.node).toBe('proxmox02'); // stored node kept, not the malformed value
  expect(writes).toEqual([]);
  expect(logged.some((line) => line.includes('malformed'))).toBe(true);
});

test('a missing node field from cluster resources is ignored the same way', async () => {
  const writes = [];
  const logged = [];
  const box = linked('b1', 'proxmox02', 165);
  const inventory = createProxmoxInventory({
    proxmoxStore: { getHost: async () => HOST },
    makeClient: () => ({ clusterResources: async () => [{ vmid: 165, type: 'lxc', status: 'running', name: 'dev' }] }),
    boxStore: { setProxmoxLink: async (id, link) => writes.push([id, link]), getBox: async () => box },
    now: () => 1000, log: (...a) => logged.push(a.join(' ')),
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.node).toBe('proxmox02');
  expect(writes).toEqual([]);
  expect(logged.some((line) => line.includes('malformed'))).toBe(true);
});

test('the drift write is skipped if the link was cleared mid-poll (stale-link re-check)', async () => {
  const writes = [];
  const box = linked('b1', 'proxmox02', 165);
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: {
      setProxmoxLink: async (id, link) => writes.push([id, link]),
      getBox: async () => ({ ...box, proxmox: null }), // user cleared the link between snapshot and write
    },
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.node).toBe('proxmox03'); // display still follows the live cluster value
  expect(writes).toEqual([]);
});

test('the drift write proceeds when the fresh link still matches the observed one (control)', async () => {
  const writes = [];
  const box = linked('b1', 'proxmox02', 165);
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: {
      setProxmoxLink: async (id, link) => writes.push([id, link]),
      getBox: async () => linked('b1', 'proxmox02', 165), // different object, same field values
    },
  });
  const [record] = await inventory.refreshLinked([box]);
  expect(record.node).toBe('proxmox03');
  expect(writes).toEqual([['b1', { hostId: 'H1', node: 'proxmox03', vmid: 165, endpoint: HOST.endpoint }]]);
});

test('missing means absent from the whole cluster; qemu entries never match', async () => {
  const { inventory } = setup({ cluster: [
    { vmid: 131, node: 'pve2', type: 'qemu', status: 'running', name: 'a-vm' }, // same vmid, wrong type
  ] });
  const [record] = await inventory.refreshLinked([linked('b1', 'pve', 131)]);
  expect(record.state).toBe('missing');
  expect(record.node).toBe('pve'); // stored node kept for display when missing
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

test('listNodeContainers annotates existing links', async () => {
  const { inventory } = setup({ listByNode: { pve: [{ vmid: 131, name: 'dev-01', status: 'running' }, { vmid: 132, name: 'free', status: 'stopped' }] } });
  expect(await inventory.listNodeContainers('H1', 'pve', [linked('b1', 'pve', 131)])).toEqual([
    { hostId: 'H1', node: 'pve', vmid: 131, name: 'dev-01', state: 'running', linkedBoxId: 'b1' },
    { hostId: 'H1', node: 'pve', vmid: 132, name: 'free', state: 'stopped', linkedBoxId: null },
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
  expect(writes).toEqual([['b1', { hostId: 'H9', node: 'pve', vmid: 131, endpoint: HOST.endpoint, netboxIpId: 99 }]]);
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
  const box = linked('b1', 'proxmox02', 165);
  box.proxmox.netboxIpId = 99;
  const { inventory } = setup({
    cluster: [{ vmid: 165, node: 'proxmox03', type: 'lxc', status: 'running', name: 'dev' }],
    boxStore: { getBox: async () => box, setProxmoxLink: async (id, link) => writes.push([id, link]) },
  });
  await inventory.refreshLinked([box]);
  expect(writes[0][1].netboxIpId).toBe(99);
});
